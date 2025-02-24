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

            /* remove our private IP from the set of active SBCs so rtp and fs know we are gone */
            removeFromRedis();

            /* if we have zero calls, we can complete the scale-in right now */
            const calls = activeCallIds.size;
            if (0 === calls) {
              logger.info('scale-in can complete immediately as we have no calls in progress');
              lifecycleEmitter.completeScaleIn();
            }
            else {
              logger.info(`${calls} calls in progress; scale-in will complete when they are done`);
            }
          })
          .on(LifeCycleEvents.StandbyEnter, () => {
            lifecycleEmitter.dryUpCalls = true;
            const {srf} = require('..');
            const {removeFromRedis} = srf.locals;
            removeFromRedis();

            logger.info('AWS enter pending state notification: begin drying up calls');
          })
          .on(LifeCycleEvents.StandbyExit, () => {
            lifecycleEmitter.dryUpCalls = false;
            const {srf} = require('..');
            const {addToRedis} = srf.locals;
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

