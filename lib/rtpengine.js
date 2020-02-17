const assert = require('assert');
const Client = require('rtpengine-client').Client ;
const client = new Client({timeout: 1500});
const debug = require('debug')('jambonz:sbc-inbound');
let timer;

const engines = process.env.JAMBONES_RTPENGINES
  .split(',')
  .map((hp) => {
    const arr = /^(.*):(.*)$/.exec(hp.trim());
    if (!arr) throw new Error('JAMBONES_RTPENGINES must be an array host:port addresses');
    const engine = {
      active: true,
      calls: 0,
      host: arr[1],
      port: parseInt(arr[2])
    };
    [
      'offer',
      'answer',
      'delete',
      'list',
      'startRecording',
      'stopRecording'
    ].forEach((method) => engine[method] = client[method].bind(client, engine.port, engine.host));
    return engine;
  });
assert.ok(engines.length > 0, 'JAMBONES_RTPENGINES must be an array host:port addresses');
debug(`engines: ${JSON.stringify(engines)}`);

function testEngines(logger) {
  return setInterval(() => {
    engines.forEach(async(engine) => {
      try {
        const res = await engine.list();
        if ('ok' === res.result) {
          engine.calls = res.calls.length;
          engine.active = true;
          logger.info({res}, `rtpengine:list ${engine.host}:${engine.port} has ${engine.calls} calls`);
          return;
        }
        logger.info({rtpengine: engine.host, response: res}, 'Failure response from rtpengine');
        engine.active = false;
      } catch (err) {
        logger.info({rtpengine: engine.host, err}, 'Failure response from rtpengine');
      }
      engine.active = false;
    });
  }, 5000);
}

const selectClient = () => engines.filter((c) => c.active).sort((a, b) => (a.calls - b.calls)).shift();

function getRtpEngine(logger) {
  if (!timer) timer = testEngines(logger);
  return () => {
    const engine = selectClient();
    if (engine) {
      debug({engine}, 'selected engine');
      return {
        offer: engine.offer,
        answer: engine.answer,
        del: engine.delete
      };
    }
  };
}

module.exports = getRtpEngine;
