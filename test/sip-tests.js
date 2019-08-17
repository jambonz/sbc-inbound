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

test('invite handler', (t) => {
  clearModule('../app');
  const {srf, disconnectMs} = require('../app');

  connect(srf)
    .then(() => {
      return sippUac('uac-pcap.xml');
    })
    .then(() => {
      t.pass('successfully connected call');
      if (srf.locals.lb) srf.locals.lb.disconnect();
      srf.disconnect();
      t.end();
      return;
    })
    .catch((err) => {
      if (srf.locals.lb) srf.locals.lb.disconnect();
      if (srf) srf.disconnect();
      console.log(`error received: ${err}`);
      t.error(err);
    });
});

