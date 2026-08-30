const noopLogger = {info: () => {}, error: () => {}};
const {LifeCycleEvents} = require('./constants');
const Emitter = require('events');

module.exports = (logger) => {
  logger = logger || noopLogger;

  // listen for SNS lifecycle changes
  let lifecycleEmitter = new Emitter();
  lifecycleEmitter.dryUpCalls = false;
  if (process.env.AWS_SNS_TOPIC_ARN) {

    (async function() {
      try {
        lifecycleEmitter = await require('./aws-sns-lifecycle')(logger);

        lifecycleEmitter
          .on(LifeCycleEvents.ScaleIn, async() => {
            logger.info('AWS scale-in notification: begin drying up calls');
            lifecycleEmitter.dryUpCalls = true;
            lifecycleEmitter.operationalState = LifeCycleEvents.ScaleIn;

            const {srf} = require('..');
            const {activeCallIds, removeFromRedis} = srf.locals;

            /* reject new INVITEs with 503 so senders fail over to another SBC */
            srf.locals.dryUpCalls = true;

            /* remove our private IP from the set of active SBCs so rtp and fs know we are gone */
            removeFromRedis();

            /* count calls in progress across all sbc-inbound and sbc-outbound
               processes on this server, if they are reporting; otherwise
               fall back to counting only our own */
            const countServerCalls = async() => {
              const reporter = srf.locals.callCountReporter;
              if (!reporter) return activeCallIds.size;
              const {retrieveSet, retrieveKey} = srf.locals.realtimeDbHelpers;
              const keys = await retrieveSet(reporter.setName);
              let count = 0;
              for (const key of keys) {
                count += parseInt(await retrieveKey(key), 10) || 0;
              }
              return Math.max(count, activeCallIds.size);
            };

            /* poll until calls have dried up, then complete the scale-in;
               require two consecutive zero readings since reported counts
               may be up to 15s stale */
            let consecutiveZeroCounts = 0;
            const timer = setInterval(async() => {
              try {
                const calls = await countServerCalls();
                if (0 === calls) {
                  if (++consecutiveZeroCounts >= 2) {
                    clearInterval(timer);
                    logger.info('scale-in complete now that calls have dried up');
                    lifecycleEmitter.completeScaleIn();
                  }
                }
                else {
                  consecutiveZeroCounts = 0;
                  logger.info(`${calls} calls in progress on this server; scale-in will complete when they are done`);
                }
              } catch (err) {
                logger.error({err}, 'Error counting calls in progress during scale-in');
              }
            }, 20000);
          })
          .on(LifeCycleEvents.StandbyEnter, () => {
            lifecycleEmitter.dryUpCalls = true;
            const {srf} = require('..');
            const {removeFromRedis} = srf.locals;
            srf.locals.dryUpCalls = true;
            removeFromRedis();

            logger.info('AWS enter pending state notification: begin drying up calls');
          })
          .on(LifeCycleEvents.StandbyExit, () => {
            lifecycleEmitter.dryUpCalls = false;
            const {srf} = require('..');
            const {addToRedis} = srf.locals;
            srf.locals.dryUpCalls = false;
            addToRedis();

            logger.info('AWS exit pending state notification: re-enable calls');
          });
      } catch (err) {
        logger.error({err}, 'Failure creating SNS notifier, lifecycle events will be disabled');
      }
    })();
  }
  else if (process.env.K8S) {
    lifecycleEmitter.scaleIn = () => process.exit(0);
  }

  return {lifecycleEmitter};
};

