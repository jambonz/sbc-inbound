const config = require('config');
const Client = require('rtpengine-client').Client ;
const rtpengine = new Client();
const offer = rtpengine.offer.bind(rtpengine, config.get('rtpengine'));
const answer = rtpengine.answer.bind(rtpengine, config.get('rtpengine'));
const del = rtpengine.delete.bind(rtpengine, config.get('rtpengine'));
const {getAppserver, isWSS} = require('./utils');

module.exports = handler;

function handler({logger}) {
  return async(req, res) => {
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

      const {uas, uac} = await srf.createB2BUA(req, res, {
        proxy: uri,
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

      [uas, uac].forEach((dlg) => dlg.on('destroy', () => {
        logger.info('call ended');
        dlg.other.destroy();
        rtpEngineResource.destroy();
      }));
    } catch (err) {
      logger.error(err, 'Error connecting call');
      rtpEngineResource.destroy();
    }
  };
}

function makeRtpEngineOpts(req, srcIsUsingSrtp, dstIsUsingSrtp) {
  const from = req.getParsedHeader('from');
  const common = {'call-id': req.get('Call-ID'), 'from-tag': from.params.tag};
  const rtpCharacteristics = config.get('transcoding.rtpCharacteristics');
  const srtpCharacteristics = config.get('transcoding.srtpCharacteristics');
  return {
    common,
    offer: Object.assign({'sdp': req.body, 'replace': ['origin', 'session-connection']}, common,
      dstIsUsingSrtp ? srtpCharacteristics : rtpCharacteristics),
    answer: Object.assign({}, common, srcIsUsingSrtp ? srtpCharacteristics : rtpCharacteristics)
  };
}
