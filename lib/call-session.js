const Emitter = require('events');
const {isWSS, makeRtpEngineOpts} = require('./utils');
const {forwardInDialogRequests} = require('drachtio-fn-b2b-sugar');
const {parseUri, SipError} = require('drachtio-srf');
const debug = require('debug')('jambonz:sbc-inbound');

/**
 * this is to make sure the outgoing From has the number in the incoming From
 * and not the incoming PAI
 */
const createBLegFromHeader = (req) => {
  const from = req.getParsedHeader('From');
  const uri = parseUri(from.uri);
  if (uri && uri.user) return `sip:${uri.user}@localhost`;
  return 'sip:anonymous@localhost';
};

class CallSession extends Emitter {
  constructor(logger, req, res) {
    super();
    this.req = req;
    this.res = res;
    this.srf = req.srf;
    this.logger = logger.child({callId: req.get('Call-ID')});

    this.getRtpEngine = req.srf.locals.getRtpEngine;
    this.getFeatureServer = req.srf.locals.getFeatureServer;
    this.stats = this.srf.locals.stats;
    this.activeCallIds = this.srf.locals.activeCallIds;
  }

  async connect() {
    this.logger.info('inbound call accepted for routing');
    const engine = this.getRtpEngine();
    if (!engine) {
      this.logger.info('No available rtpengines, rejecting call!');
      const tags = ['accepted:no', 'sipStatus:480', `originator:${this.req.locals.originator}`];
      this.stats.increment('sbc.terminations', tags);
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
      const tags = ['accepted:no', 'sipStatus:480', `originator:${this.req.locals.originator}`];
      this.stats.increment('sbc.terminations', tags);
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
      proxy = `sip:${featureServer}`;
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
        'From': createBLegFromHeader(this.req),
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
        if (this.req.authorization.challengeResponse) {
          const {username, realm} = this.req.authorization.challengeResponse;
          Object.assign(headers, {'X-Authenticated-User': `${username}@${realm}`});
        }
      }

      if (this.req.canceled) throw new Error('call canceled');

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
      this.logger.info('call connected successfully to feature server');
      this._setHandlers({uas, uac});
      return;
    } catch (err) {
      this.rtpEngineResource.destroy();
      this.activeCallIds.delete(this.req.get('Call-ID'));
      this.stats.gauge('sbc.sip.calls.count', this.activeCallIds.size);
      if (err instanceof SipError) {
        const tags = ['accepted:no', `sipStatus:${err.status}`, `originator:${this.req.locals.originator}`];
        this.stats.increment('sbc.terminations', tags);
        this.logger.info(`call failed to connect to feature server with ${err.status}`);
        return this.emit('failed');
      }
      else if (err.message !== 'call canceled') {
        this.logger.error(err, 'unexpected error routing inbound call');
      }
    }
  }

  _setHandlers({uas, uac}) {
    this.emit('connected');
    const tags = ['accepted:yes', 'sipStatus:200', `originator:${this.req.locals.originator}`];
    this.stats.increment('sbc.terminations', tags);
    this.activeCallIds.add(this.req.get('Call-ID'));

    this.uas = uas;
    this.uac = uac;
    [uas, uac].forEach((dlg) => {
      //hangup
      dlg.on('destroy', () => {
        this.logger.info('call ended with normal termination');
        this.rtpEngineResource.destroy();
        this.activeCallIds.delete(this.req.get('Call-ID'));
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
