# sbc-inbound [![Build Status](https://secure.travis-ci.org/jambonz/sbc-inbound.png)](http://travis-ci.org/jambonz/sbc-inbound)

This application provides a part of the SBC (Session Border Controller) functionality of jambonz.  It handles incoming INVITE requests from carrier sip trunks or from sip devices and webrtc applications. SIP INVITEs from known carriers are allowed in, while INVITEs from sip devices are challenged to authenticate.  SIP traffic that is allowed in is sent on to a jambonz application server in a private subnet.

## Configuration

Configuration is provided via the [npmjs config](https://www.npmjs.com/package/config) package.  The following elements make up the configuration for the application:
##### drachtio server location
```
{
  "drachtio": {
    "port": 3001,
    "secret": "cymru"
  },
```
the `drachtio` object specifies the port to listen on for tcp connections from drachtio servers as well as the shared secret that is used to authenticate to the server.

> Note: either inbound or [outbound connections](https://drachtio.org/docs#outbound-connections) may be used, depending on the configuration supplied.  In production, it is the intent to use outbound connections for easier centralization and clustering of application logic, while inbound connections are used for the automated test suite.

##### rtpengine location
```
  "rtpengine": {
    "host": "127.0.0.1",
    "port": 22222
  },
```
the `rtpengine` object specifies the location of the rtpengine, which will typically be running on the same server as drachtio.

##### application log level
```
  "logging": {
    "level": "info"
  }
```
##### authentication web callback
```
  "authCallback": {
    "uri": "http://example.com/auth",
    "auth": {
      "username": "foo",
      "password": "bar"
    }
  },
```
the `authCallback` object specifies the http(s) url that a POST request will be sent to for each incoming REGISTER request.  The body of the POST will be a json payload including the following information:
```
    {
      "method": "REGISTER",
      "username": "daveh",
      "realm": "drachtio.org",
      "nonce": "2q4gct3g3ghbfj34h3",
      "uri": "sip:dhorton@drachtio.org",
      "response": "djaduys9g9d",
    }
```
It is the responsibility of the customer-side logic to retrieve the associated password for the given username and authenticate the request by calculating a response token (per the algorithm described in [RFC 2617](https://tools.ietf.org/html/rfc2617#section-3.2.2)) and comparing it to that provided in the request.  

The `auth` property in the `authCallback` object is optional.  It should be provided if the customer callback is using HTTP Basic Authentication to protect the endpoint.

If the request is successfully authenticated, the callback should return a 200 OK response with a JSON body including:
```
{"status": "ok"}
```
This will signal the application to accept the registration request, respond accordingly to the client, and update the redis database with the active registration.

In the case of failure, the customer-side application *should* return a 'msg' property indicating the reason, e.g.
```
{"status": "fail", "msg": "invalid username"}
```
##### sip trunks
Inbound sip trunks are configured by specifing name and associated ip addresses.  Additionally, the sip trunk for internal jambonz application servers is specified as an array of IP addresses.
```
  "trunks": {
    "inbound": [
      {
        "name": "carrier1",
        "host": ["10.123.22.3"]
      }
    ],
    "appserver": ["sip:10.10.120.1"]
  }
  ```
  ##### transcoding options
  The transcoding options for rtpengine are found in the configuration file, however these should not need to be modified.
  ```
    "transcoding": {
    "rtpCharacteristics" : {
       "transport protocol": "RTP/AVP",
       "DTLS": "off",
       "SDES": "off",
       "ICE": "remove",
       "rtcp-mux": ["demux"]
    },
    "srtpCharacteristics": {
       "transport-protocol": "UDP/TLS/RTP/SAVPF",
       "ICE": "force",
       "SDES": "off",
       "flags": ["generate mid", "SDES-no"],
       "rtcp-mux": ["require"]
    } 
  }
  ```
## Forwarding behavior
This application acts as a back-to-back user agent and media proxy.  When sending INVITEs on to the jambonz application servers, it adds the following headers onto the INVITE:

- `X-Forwarded-For`: the IP address of the client that sent the INVITE
- `X-Forwarded-Proto`: the transport protocol used by the client
- `X-Forwarded-Carrier`: the name of the inbound carrier, if applicable

## Tests
The automated test suite requires a docker installation.

```
npm test
```
