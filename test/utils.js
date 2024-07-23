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
    const req = {
      "referTo": { "uri": "sip:@202660.tenios.com" },
      getParsedHeader: () => ({ "uri": "sip:@202660.tenios.com" })
    };
    // "refer-to":"<sip:+49221578952870@202660.tenios.com>"
    // <sip:@202660.tenios.com>

    const referTo = req.getParsedHeader('Refer-To');
    const uri = parseUri(referTo.uri);
    // uri.user does not exist
    const arr = /context-(.*)/.exec(uri.user);

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

    t.ok(uri.family === expected.family, 'sip endpoint tls');
    t.ok(uri.scheme === expected.scheme, 'sip endpoint wss');
    t.ok(uri.password === expected.password, 'sip endpoint tcp');
    t.ok(uri.host === expected.host, 'sip endpoint udp');    
    t.ok(typeof uri.params === 'object', 'sip endpoint udp');
    t.ok(typeof uri.headers === 'object', 'sip endpoint udp');

    t.end();
  } catch (err) {
    console.log(`error received: ${err}`);
    t.error(err);
  }
});