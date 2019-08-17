const test = require('blue-tape');
const { output, sippUac } = require('./sipp')('test_sbc-inbound');
const debug = require('debug')('drachtio:sbc-inbound');
const clearModule = require('clear-module');

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

test('incoming call tests', (t) => {
  const {srf} = require('../app');

  connect(srf)
    .then(() => {
      return sippUac('uac-pcap-carrier-success.xml', '172.38.0.20');
    })
    .then(() => {
      return t.pass('incoming call from carrier completed successfully');
    })
    .then(() => {
      return sippUac('uac-pcap-device-success.xml', '172.38.0.30');
    })
    .then(() => {
      return t.pass('incoming call from authenticated device completed successfully');
    })
    .then(() => {
      srf.disconnect();
      t.end();
      return;
    })
    .catch((err) => {
      console.log(`error received: ${err}`);
      if (srf) srf.disconnect();
      t.error(err);
    });
});
