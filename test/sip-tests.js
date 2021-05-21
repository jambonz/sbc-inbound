const test = require('tape');
const { output, sippUac } = require('./sipp')('test_sbc-inbound');
const debug = require('debug')('drachtio:sbc-inbound');
const clearModule = require('clear-module');
const consoleLogger = {error: console.error, info: console.log, debug: console.log};

process.on('unhandledRejection', (reason, p) => {
  console.log('Unhandled Rejection at: Promise', p, 'reason:', reason);
});

function connect(connectable) {
  return new Promise((resolve, reject) => {
    connectable.on('connect', () => {
      return resolve();
    });
  });
}

function waitFor(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms * 1000);
  });
}

test('incoming call tests', async(t) => {
  const {srf} = require('../app');
  const { queryCdrs } = srf.locals;
  
  try {
    await connect(srf);
    await sippUac('uac-pcap-carrier-success.xml', '172.38.0.20');
    t.pass('incoming call from carrier completed successfully');
  
    await sippUac('uac-pcap-pbx-success.xml', '172.38.0.21');
    t.pass('incoming call from account-level carrier completed successfully');
  
    await sippUac('uac-pcap-device-success.xml', '172.38.0.30');
    t.pass('incoming call from authenticated device completed successfully');
  
    await sippUac('uac-device-unknown-user.xml', '172.38.0.30');
    t.pass('unknown user is rejected with a 403');
  
    await sippUac('uac-device-unknown-realm.xml', '172.38.0.30');
    t.pass('unknown realm is rejected with a 404');
  
    await sippUac('uac-device-invalid-password.xml', '172.38.0.30');
    t.pass('invalid password for valid user is rejected with a 403');
  
    await sippUac('uac-pcap-device-success-in-dialog-request.xml', '172.38.0.30');
    t.pass('handles in-dialog requests');
  
    await sippUac('uac-pcap-carrier-max-call-limit.xml', '172.38.0.20');
    t.pass('rejects incoming call with 503 when max calls reached')
  
    await waitFor(10);
    const res = await queryCdrs({account_sid: 'ed649e33-e771-403a-8c99-1780eabbc803'});
    console.log(`cdrs: ${JSON.stringify(res)}`);
    t.ok(6 === res.total, 'successfully wrote 6 cdrs for calls');

    srf.disconnect();
    t.end();
  } catch (err) {
    console.log(`error received: ${err}`);
    if (srf) srf.disconnect();
    t.error(err);
  }
});
