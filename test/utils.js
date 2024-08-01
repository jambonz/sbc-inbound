const test = require('tape');
const { parseHostPorts } = require('../lib/utils');
const { parseUri } = require('drachtio-srf');

process.on('unhandledRejection', (reason, p) => {
  console.log('Unhandled Rejection at: Promise', p, 'reason:', reason);
});

const hostports = "tls/3.70.141.74:5061,wss/3.70.141.74:8443,tcp/3.70.141.74:5060,udp/3.70.141.74:5060";
const hostportsNoTls = "wss/3.70.141.74:8443,tcp/3.70.141.74:5060,udp/3.70.141.74:5060";
const logger = { info: (args) => console.log(args) };

const srf = {
  locals: {
    sipAddress: '127.0.0.1'
  }
};

test('utils tests - parseHostPorts', async (t) => {
  try {
    let obj = parseHostPorts(logger, hostports, srf);

    const expected = {
      tls: '3.70.141.74:5061',
      wss: '3.70.141.74:8443',
      tcp: '3.70.141.74:5060',
      udp: '3.70.141.74:5060'
    };

    t.ok(obj.tls === expected.tls, 'sip endpoint tls');
    t.ok(obj.wss === expected.wss, 'sip endpoint wss');
    t.ok(obj.tcp === expected.tcp, 'sip endpoint tcp');
    t.ok(obj.udp === expected.udp, 'sip endpoint udp');

    obj = parseHostPorts(logger, hostportsNoTls.split(','), srf);

    t.ok(obj.tls === '127.0.0.1:5061', 'sip endpoint tls');

    t.end();
  } catch (err) {
    console.log(`error received: ${err}`);
    t.error(err);
  }
});


test('utils tests - parse URI user', async (t) => {
  try {
    let invalidUri = "sip:@202660.tenios.com";
    const req = {
      getParsedHeader: () => ({ uri: invalidUri })
    };

    const referTo = req.getParsedHeader('Refer-To');
    let uri = parseUri(referTo.uri);
    
    const expected = {
      family: "ipv4",
      scheme: "sip",
      user: "",
      password: undefined,
      host: "202660.tenios.com",
      port: NaN,
      params: {},
      headers: {},
    }

    t.ok(uri.family === expected.family, 'family eq ipv4');
    t.ok(uri.scheme === expected.scheme, 'scheme eq sip');
    t.ok(uri.password === expected.password, 'pw eq undefined');
    t.ok(uri.host === expected.host, 'host eq 202660.tenios.com');
    t.ok(uri.user === "", 'user eq empty string');
    t.ok(isNaN(uri.port), 'port eq NaN');
    t.ok(typeof uri.params === 'object', 'params eq object');
    t.ok(typeof uri.headers === 'object', 'headers eq object');

    invalidUri = "<sip:@202660.tenios.com>";    
    uri = parseUri(invalidUri);
    /* TODO: uri can be undefined - check these conditions in call-session */
    t.ok(uri === undefined, 'uri is undefined');

    const validUri = "<sip:+49221578952870@202660.tenios.com>";

    t.end();
  } catch (err) {
    console.log(`error received: ${err}`);
    t.error(err);
  }
});