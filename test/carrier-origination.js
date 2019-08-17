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

test('incoming call from carrier', (t) => {
  clearModule('../app');
  const {srf} = require('../app');

  connect(srf)
    .then(() => {
      return sippUac('uac-pcap-carrier-success.xml', '172.38.0.20');
    })
    .then(() => {
      t.pass('successfully connected incoming call from carrier');
      srf.disconnect();
      t.end();
      return;
    })
    .catch((err) => {
      if (srf) srf.disconnect();
      console.log(`error received: ${err}`);
      t.error(err);
    });
});

