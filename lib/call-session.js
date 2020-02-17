const Emitter = require('events');
const {getAppserver, isWSS, makeRtpEngineOpts} = require('./utils');
const {forwardInDialogRequests} = require('drachtio-fn-b2b-sugar');
const {parseUri, SipError} = require('drachtio-srf');
const {getRtpEngine} = require('jambonz-rtpengine-utils')(process.env.JAMBONES_RTPENGINES.split(','));
const debug = require('debug')('jambonz:sbc-inbound');

class CallSession extends Emitter {
  constructor(logger, req, res) {
    super();
    this.req = req;
    this.res = res;
    this.srf = req.srf;
    this.logger = logger.child({callId: req.get('Call-ID')});

    this.getFeatureServer = require('./fs-tracking')(this.srf, this.logger);
  }

  async connect() {
    const engine = getRtpEngine(this.logger);
    if (!engine) {
      this.logger.info('No available rtpengines, rejecting call!');
      return this.res.send(480);
    }
    debug(`got engine: ${JSON.stringify(engine)}`);
    const {offer, answer, del} = engine;
    this.offer = offer;
    this.answer = answer;
    this.del = del;

    const featureServer = this.getFeatureServer();
    if (!featureServer) {
      this.logger.info('No available feature servers, rejecting call!');
      return this.res.send(480);
    }
    debug(`using feature server ${featureServer}`);

    this.rtpEngineOpts = makeRtpEngineOpts(this.req, isWSS(this.req), false);
    this.rtpEngineResource = {destroy: this.del.bind(null, this.rtpEngineOpts.common)};
    const obj = parseUri(this.req.uri);
    let proxy, host, uri;

    // replace host part of uri if its an ipv4 address, leave it otherwise
    if (/\d{1-3}\.\d{1-3}\.\d{1-3}\.\d{1-3}/.test(obj.host)) {
      host = obj.host;
      proxy = featureServer;
    }
    else {
      host = featureServer;
    }
    if (obj.user) uri = `${obj.scheme}:${obj.user}@${host}`;
    else uri = `${obj.scheme}:${host}`;
    debug(`uri will be: ${uri}, proxy ${proxy}`);

    try {
      const response = await this.offer(this.rtpEngineOpts.offer);
      debug(`response from rtpengine to offer ${JSON.stringify(response)}`);
      if ('ok' !== response.result) {
        this.logger.error(`rtpengine offer failed with ${JSON.stringify(response)}`);
        throw new Error('rtpengine failed: answer');
      }

      // now send the INVITE in towards the feature servers
      const headers = {
        'X-CID': this.req.get('Call-ID'),
        'X-Forwarded-For': `${this.req.source_address}:${this.req.source_port}`
      };
      if (this.req.locals.carrier) Object.assign(headers, {'X-Originating-Carrier': this.req.locals.carrier});
      if (this.req.locals.application_sid) {
        Object.assign(headers, {'X-Application-Sid': this.req.locals.application_sid});
      }
      else if (this.req.authorization) {
        if (this.req.authorization.grant && this.req.authorization.grant.application_sid) {
          Object.assign(headers, {'X-Application-Sid': this.req.authorization.grant.application_sid});
        }
        else if (this.req.authorization.challengeResponse) {
          const {username, realm} = this.req.authorization.challengeResponse;
          Object.assign(headers, {'X-Authenticated-User': `${username}@${realm}`});
        }
      }

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
          const response = await this.answer(opts);
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
      this.rtpEngineResource.destroy();
      if (err instanceof SipError) {
        this.logger.info(`call failed with ${err.status}`);
        return this.emit('failed');
      }
      this.logger.error(err, 'unexpected error routing inbound call');
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
      let response = await this.offer(Object.assign({sdp: req.body}, this.rtpEngineOpts.offer));
      if ('ok' !== response.result) {
        res.send(488);
        throw new Error(`_onReinvite: rtpengine failed: offer: ${JSON.stringify(response)}`);
      }
      const sdp = await dlg.other.modify(response.sdp);
      const opts = Object.assign({sdp, 'to-tag': res.getParsedHeader('To').params.tag},
        this.rtpEngineOpts.answer);
      response = await this.answer(opts);
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
