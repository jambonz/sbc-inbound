const test = require('tape');
const { sippUac } = require('./sipp')('test_sbc-inbound');
const bent = require('bent');
const getJSON = bent('json');

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
  let res;
  
  try {
    await connect(srf);

    let obj = await getJSON('http://127.0.0.1:3050/');
    t.ok(obj.calls === 0, 'HTTP GET / works (current call count)')
    obj = await getJSON('http://127.0.0.1:3050/system-health');
    t.ok(obj.calls === 0, 'HTTP GET /system-health works (health check)')

    await sippUac('uac-late-media.xml', '172.38.0.20');
    t.pass('incoming call with no SDP packet is rejected with a 488');

    await sippUac('uac-did-applicationsid-loop.xml', '172.38.0.20');
    t.pass('incoming call with x-application-sid header is rejected with 482');

    await sippUac('uac-pcap-carrier-success.xml', '172.38.0.20');
    t.pass('incoming call from carrier completed successfully');

    await sippUac('uac-pcap-pbx-success.xml', '172.38.0.21');
    t.pass('incoming call from account-level carrier completed successfully');
  
    await sippUac('uac-did-regex-match.xml', '172.38.0.20');
    t.pass('incoming call matched by trailing wildcard *');
  
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
    t.pass('rejects incoming call with 503 when max calls per account reached');

    await sippUac('uac-did-regex-match-vc-all-accts.xml', '172.38.0.50');
    t.pass('incoming call matched by trailing wildcard *, voice gateway belongs to all accounts, with sip realm');

    await sippUac('uac-did-regex-match-vc-all-accts-nosiprealm.xml', '172.38.0.51');
    t.pass('incoming call matched by trailing wildcard *, voice gateway belongs to all accounts, without sip realm');

    await sippUac('uac-did-regex-match-vc-all-accts-nosiprealm.xml', '172.38.0.50');
    t.pass('incoming call matched by trailing wildcard *, voice gateway belongs to all accounts, without sip realm');

    /* switch off this env for remaining tests (JAMBONES_HOSTING is for Saas sts) */
    delete process.env.JAMBONES_HOSTING;
    await sippUac('uac-pcap-carrier-fail-ambiguous.xml', '172.38.0.40');
    t.pass('rejects incoming call with 503 when multiple accounts have same carrier witrh default routing')
  
    await waitFor(12);
    const res = await queryCdrs({account_sid: 'ed649e33-e771-403a-8c99-1780eabbc803'});
    console.log(`cdrs res.total: ${res.total}`);
    //console.log(`cdrs: ${JSON.stringify(res)}`);
    t.ok(7 === res.total, 'successfully wrote 8 cdrs for calls');

    srf.disconnect();
    t.end();
  } catch (err) {
    console.log(`error received: ${err}`);
    if (srf) srf.disconnect();
    t.error(err);
  }
});
