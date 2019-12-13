const Emitter = require('events');
const config = require('config');
const Client = require('rtpengine-client').Client ;
const rtpengine = new Client();
const offer = rtpengine.offer.bind(rtpengine, config.get('rtpengine'));
const answer = rtpengine.answer.bind(rtpengine, config.get('rtpengine'));
const del = rtpengine.delete.bind(rtpengine, config.get('rtpengine'));
const {getAppserver, isWSS, makeRtpEngineOpts} = require('./utils');
const {forwardInDialogRequests} = require('drachtio-fn-b2b-sugar');
const {parseUri, SipError} = require('drachtio-srf');
const debug = require('debug')('jambonz:sbc-inbound');

class CallSession extends Emitter {
  constructor(logger, req, res) {
    super();
    this.req = req;
    this.res = res;
    this.srf = req.srf;
    this.logger = logger.child({callId: req.get('Call-ID')});
  }

  async connect() {
    this.rtpEngineOpts = makeRtpEngineOpts(this.req, isWSS(this.req), false);
    this.rtpEngineResource = {destroy: del.bind(rtpengine, this.rtpEngineOpts.common)};
    const obj = parseUri(this.req.uri);
    const appServer = getAppserver();
    let proxy, host, uri;

    // replace host part of uri if its an ipv4 address, leave it otherwise
    if (/\d{1-3}\.\d{1-3}\.\d{1-3}\.\d{1-3}/.test(obj.host)) {
      host = obj.host;
      proxy = appServer;
    }
    else {
      host = appServer;
    }
    if (obj.user) uri = `${obj.scheme}:${obj.user}@${host}`;
    else uri = `${obj.scheme}:${host}`;
    debug(`uri will be: ${uri}, proxy ${proxy}`);

    try {
      // rtpengine 'offer'
      debug('sending offer command to rtpengine');
      const response = await offer(this.rtpEngineOpts.offer);
      debug(`response from rtpengine to offer ${JSON.stringify(response)}`);
      if ('ok' !== response.result) {
        this.logger.error(`rtpengine offer failed with ${JSON.stringify(response)}`);
        throw new Error('rtpengine failed: answer');
      }

      // now send the INVITE in towards the feature servers
      const headers = {'X-Forwarded-For': this.req.source_address};
      if (this.req.locals.carrier) Object.assign(headers, {'X-Originating-Carrier': this.req.locals.carrier});

      debug(`sending INVITE to ${proxy} with ${uri}`);
      const {uas, uac} = await this.srf.createB2BUA(this.req, this.res, uri, {
        proxy,
        headers,
        proxyRequestHeaders: ['all', '-Authorization', '-Max-Forwards'],
        proxyResponseHeaders: ['all'],
        localSdpB: response.sdp,
        localSdpA: async(sdp, res) => {
          const opts = Object.assign({sdp, 'to-tag': res.getParsedHeader('To').params.tag},
            this.rtpEngineOpts.answer);
          const response = await answer(opts);
          if ('ok' !== response.result) {
            this.logger.error(`rtpengine answer failed with ${JSON.stringify(response)}`);
            throw new Error('rtpengine failed: answer');
          }
          return response.sdp;
        }
      });

      // successfully connected
      this.logger.info('call connected');
      debug('call connected');
      this.emit('connected');

      this._setHandlers({uas, uac});
      return;
    } catch (err) {
      if (err instanceof SipError) {
        this.logger.info(`call failed with ${err.status}`);
        this.emit('failed');
        this.rtpEngineResource.destroy();
      }
    }
  }

  _setHandlers({uas, uac}) {
    this.uas = uas;
    this.uac = uac;
    [uas, uac].forEach((dlg) => {
      //hangup
      dlg.on('destroy', () => {
        this.logger.info('call ended');
        this.rtpEngineResource.destroy();
      });

      //re-invite
      dlg.on('modify', this._onReinvite.bind(this, dlg));
    });

    // default forwarding of other request types
    forwardInDialogRequests(uas);
  }

  async _onReinvite(dlg, req, res) {
    try {
      let response = await offer(Object.assign({sdp: req.body}, this.rtpEngineOpts.offer));
      if ('ok' !== response.result) {
        res.send(488);
        throw new Error(`_onReinvite: rtpengine failed: offer: ${JSON.stringify(response)}`);
      }
      const sdp = await dlg.other.modify(response.sdp);
      const opts = Object.assign({sdp, 'to-tag': res.getParsedHeader('To').params.tag},
        this.rtpEngineOpts.answer);
      response = await answer(opts);
      if ('ok' !== response.result) {
        res.send(488);
        throw new Error(`_onReinvite: rtpengine failed: ${JSON.stringify(response)}`);
      }
      res.send(200, {body: response.sdp});
    } catch (err) {
      this.logger.error(err, 'Error handling reinvite');
    }
  }

}

module.exports = CallSession;
