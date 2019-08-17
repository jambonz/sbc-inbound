const config = require('config');
const Client = require('rtpengine-client').Client ;
const rtpengine = new Client();
const offer = rtpengine.offer.bind(rtpengine, config.get('rtpengine'));
const answer = rtpengine.answer.bind(rtpengine, config.get('rtpengine'));
const del = rtpengine.delete.bind(rtpengine, config.get('rtpengine'));
const {getAppserver, isWSS, makeRtpEngineOpts} = require('./utils');

module.exports = handler;

function handler({log}) {
  return async(req, res) => {
    const logger = log.child({callId: req.get('Call-ID')});
    const srf = req.srf;
    const rtpEngineOpts = makeRtpEngineOpts(req, isWSS(req), false);
    const rtpEngineResource = {destroy: del.bind(rtpengine, rtpEngineOpts.common)};
    const uri = getAppserver();
    logger.info(`received inbound INVITE from ${req.protocol}/${req.source_address}:${req.source_port}`);
    try {
      const response = await offer(rtpEngineOpts.offer);
      if ('ok' !== response.result) {
        res.send(480);
        throw new Error(`failed allocating rtpengine endpoint: ${JSON.stringify(response)}`);
      }

      const {uas, uac} = await srf.createB2BUA(req, res, uri, {
        headers: {
          'X-Forwarded-For': req.source_address,
          'X-Forwarded-Proto': req.getParsedHeader('Via')[0].protocol.toLowerCase(),
          'X-Forwarded-Carrier': req.carrier_name
        },
        proxyRequestHeaders: ['User-Agent', 'Subject'],
        localSdpB: response.sdp,
        localSdpA: (sdp, res) => {  
          const opts = Object.assign({sdp, 'to-tag': res.getParsedHeader('To').params.tag},
            rtpEngineOpts.answer);
          return answer(opts)
            .then((response) => {
              if ('ok' !== response.result) throw new Error('error allocating rtpengine');
              return response.sdp;
            });
        }
      });
      logger.info('call connected');
      setHandlers(logger, uas, uac, rtpEngineResource);

    } catch (err) {
      logger.error(err, 'Error connecting call');
      rtpEngineResource.destroy();
    }
  };
}

function setHandlers(logger, uas, uac, rtpEngineResource) {
  [uas, uac].forEach((dlg) => dlg.on('destroy', () => {
    logger.info('call ended');
    dlg.other.destroy();
    rtpEngineResource.destroy();
  }));

  //TODO: handle re-INVITEs, REFER, INFO
}
