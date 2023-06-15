# sbc-inbound ![Build Status](https://github.com/jambonz/sbc-inbound/workflows/CI/badge.svg)

This application provides a part of the SBC (Session Border Controller) functionality of jambonz platform. It handles incoming INVITE requests from carrier sip trunks or from sip devices and webrtc applications. SIP INVITEs from known carriers are allowed in, while INVITEs from sip devices are challenged to authenticate.  SIP traffic that is allowed in is sent on to a jambonz application server in a private subnet.

## Configuration

Configuration is provided via environment variables:

| variable | meaning | required?|
|----------|----------|---------|
|DRACHTIO_HOST| ip address of drachtio server (typically '127.0.0.1')|yes|
|DRACHTIO_PORT| listening port of drachtio server for control connections (typically 9022)|yes|
|DRACHTIO_SECRET| shared secret|yes|
|HTTP_PORT| http listen port |no|
|JAMBONES_LOGLEVEL| log level for application, 'info' or 'debug'|no|
|JAMBONES_MYSQL_HOST| mysql host|yes|
|JAMBONES_MYSQL_PORT| mysql port |no|
|JAMBONES_MYSQL_USER| mysql username|yes|
|JAMBONES_MYSQL_PASSWORD| mysql password|yes|
|JAMBONES_MYSQL_DATABASE| mysql data|yes|
|JAMBONES_MYSQL_CONNECTION_LIMIT| mysql connection limit |no|
|DTMF_LISTEN_PORT| DTMF listening port |no|
|JAMBONES_NG_PROTOCOL| rtpengine NG protocol |no|
|RTPENGINE_PORT| rtpengine port |no|
|JAMBONES_CLUSTER_ID| cluster id |no|
|JAMBONES_NETWORK_CIDR| CIDR of private network that feature server is running in (e.g. '172.31.0.0/16')|yes|
|JAMBONES_REDIS_HOST| redis host|yes|
|JAMBONES_REDIS_PORT|redis port|no|
|JAMBONES_RTPENGINES| commas-separated list of ip:ng-port for rtpengines (e.g. '172.31.32.10:22222')|no|
|JAMBONES_TIME_SERIES_HOST| influxdb host |yes|
|JAMBONES_TIME_SERIES_PORT| influxdb port |no|
|JAMBONES_RECORD_ALL_CALLS| enable auto record calls, 'yes' or 'no' |no|
|K8S| service running as kubernetes service |no|
|K8S_RTPENGINE_SERVICE_NAME| rtpengine service name(required for K8S) |no|
|K8S_FEATURE_SERVER_SERVICE_NAME| feature server service name(required for K8S) |no|
|JWT_SECRET| secret for signing JWT token |yes|
|ENCRYPTION_SECRET| secret for credential encryption(JWT_SECRET is deprecated) |yes|

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
##### application server location
The sip trunk routing to internal application servers are specified as an array of IP addresses.
```
  "trunks": {
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
## Authentication
Authenticating users is the responsibility of the client by exposing an http callback.  A POST request will be sent to the configured callback (i.e. the value in the `accounts.registration_hook` column in the associated sip realm value in the REGISTER request).  The body of the POST will be a json payload including the following information:
```
{
	"method": "REGISTER",
	"expires": 3600,
	"scheme": "digest",
	"username": "john",
	"realm": "jambonz.org",
	"nonce": "157590482938000",
	"uri": "sip:172.37.0.10:5060",
	"response": "be641cf7951ff23ab04c57907d59f37d",
	"qop": "auth",
	"nc": "00000001",
	"cnonce": "6b8b4567",
	"algorithm": "MD5"
}
```
It is the responsibility of the customer-side logic to retrieve the associated password for the given username and to then authenticate the request by calculating a response hash value (per the algorithm described in [RFC 2617](https://tools.ietf.org/html/rfc2617#section-3.2.2)) and comparing it to the response property in the http body.

For example code showing how to calculate the response hash given the above inputs, [see here](https://github.com/jambonz/customer-auth-server/blob/master/lib/utils.js).

For a simple, full-fledged example server doing the same, [see here](https://github.com/jambonz/customer-auth-server).

The customer server SHOULD return a 200 OK response to the http request in all cases with a json body indicating whether the request was successfully authenticated.

The body MUST include a `status` field with a value of either `ok` or `fail`, indicating whether the request was authenticated or not.
```
{"status": "ok"}
```

Additionally, in the case of failure, the body MAY include a `msg` field with a human-readable description of why the authentication failed.
```
{"status": "fail", "msg": "invalid username"}
```

## Forwarding behavior
This application acts as a back-to-back user agent and media proxy.  When sending INVITEs on to the jambonz application servers, it adds the following headers onto the INVITE:

- `X-Forwarded-For`: the IP address of the client that sent the INVITE
- `X-Forwarded-Carrier`: the name of the inbound carrier, if applicable

#### Running the test suite
To run the included test suite, you will need to have a mysql server installed on your laptop/server. You will need to set the MYSQL_ROOT_PASSWORD env variable to the mysql root password before running the tests.  The test suite creates a database named 'jambones_test' in your mysql server to run the tests against, and removes it when done.
```
MYSQL_ROOT_PASSWORD=foobar npm test
```
