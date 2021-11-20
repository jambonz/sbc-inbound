const Emitter = require('events');
const {makeRtpEngineOpts, SdpWantsSrtp, makeCallCountKey} = require('./utils');
const {forwardInDialogRequests} = require('drachtio-fn-b2b-sugar');
const {parseUri, stringifyUri, SipError} = require('drachtio-srf');
const debug = require('debug')('jambonz:sbc-inbound');
const MS_TEAMS_USER_AGENT = 'Microsoft.PSTNHub.SIPProxy';
const MS_TEAMS_SIP_ENDPOINT = 'sip.pstnhub.microsoft.com';

/**
 * this is to make sure the outgoing From has the number in the incoming From
 * and not the incoming PAI
 */
const createBLegFromHeader = (req) => {
  const from = req.getParsedHeader('From');
  const uri = parseUri(from.uri);
  if (uri && uri.user) return `<sip:${uri.user}@localhost>`;
  return '<sip:anonymous@localhost>';
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
    this.writeCdrs = this.srf.locals.writeCdrs;
    this.activeCallIds = this.srf.locals.activeCallIds;

    this.decrKey = req.srf.locals.realtimeDbHelpers.decrKey;
    this.callCountKey = makeCallCountKey(req.locals.account_sid);
  }

  get isFromMSTeams() {
    return !!this.req.locals.msTeamsTenantFqdn;
  }

  get privateSipAddress() {
    return this.srf.locals.privateSipAddress;
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
    const {
      offer,
      answer,
      del,
      blockMedia,
      unblockMedia,
      blockDTMF,
      unblockDTMF,
      subscribeDTMF,
      unsubscribeDTMF
    } = engine;
    this.offer = offer;
    this.answer = answer;
    this.del = del;
    this.blockMedia = blockMedia;
    this.unblockMedia = unblockMedia;
    this.blockDTMF = blockDTMF;
    this.unblockDTMF = unblockDTMF;
    this.subscribeDTMF = subscribeDTMF;
    this.unsubscribeDTMF = unsubscribeDTMF;

    const featureServer = await this.getFeatureServer();
    if (!featureServer) {
      this.logger.info('No available feature servers, rejecting call!');
      const tags = ['accepted:no', 'sipStatus:480', `originator:${this.req.locals.originator}`];
      this.stats.increment('sbc.terminations', tags);
      return this.res.send(480);
    }
    this.logger.debug(`using feature server ${featureServer}`);

    this.rtpEngineOpts = makeRtpEngineOpts(this.req, SdpWantsSrtp(this.req.body), false, this.isFromMSTeams);
    this.rtpEngineResource = {destroy: this.del.bind(null, this.rtpEngineOpts.common)};
    const obj = parseUri(this.req.uri);
    let proxy, host, uri;

    // replace host part of uri if its an ipv4 address, leave it otherwise
    if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(obj.host)) {
      debug(`replacing host: was ${obj.host} is ${featureServer}`);
      host = featureServer;
    }
    else {
      debug(`not replacing host: "${obj.host}"`);
      host = obj.host;
      proxy = `sip:${featureServer}`;
    }
    if (obj.user) uri = `${obj.scheme}:${obj.user}@${host}`;
    else uri = `${obj.scheme}:${host}`;
    this.logger.info(`uri will be: ${uri}, proxy ${proxy}`);

    try {
      const opts = {
        ...this.rtpEngineOpts.common,
        ...this.rtpEngineOpts.uac.mediaOpts,
        'from-tag': this.rtpEngineOpts.uas.tag,
        direction:  ['public', 'private'],
        sdp: this.req.body
      };
      const response = await this.offer(opts);
      this.logger.debug({opts, response}, 'response from rtpengine to offer');
      if ('ok' !== response.result) {
        this.logger.error({}, `rtpengine offer failed with ${JSON.stringify(response)}`);
        throw new Error('rtpengine failed: answer');
      }

      // now send the INVITE in towards the feature servers
      let headers = {
        'From': createBLegFromHeader(this.req),
        'To': this.req.get('To'),
        'X-Account-Sid': this.req.locals.account_sid,
        'X-CID': this.req.get('Call-ID'),
        'X-Forwarded-For': `${this.req.source_address}`
      };
      if (this.privateSipAddress) headers = {...headers, Contact: `<sip:${this.privateSipAddress}>`};

      const responseHeaders = {};
      if (this.req.locals.carrier) Object.assign(headers, {'X-Originating-Carrier': this.req.locals.carrier});
      if (this.req.locals.msTeamsTenantFqdn) {
        Object.assign(headers, {'X-MS-Teams-Tenant-FQDN': this.req.locals.msTeamsTenantFqdn});

        // for Microsoft Teams the Contact header must include the tenant FQDN
        Object.assign(responseHeaders, {
          Allow: 'INVITE, ACK, OPTIONS, CANCEL, BYE, NOTIFY, UPDATE, PRACK',
          Contact: `sip:${this.req.locals.msTeamsTenantFqdn}`
        });
      }
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
        responseHeaders,
        proxyRequestHeaders: [
          'all',
          '-Authorization',
          '-Max-Forwards',
          '-Record-Route',
          '-Session-Expires',
          '-X-Subspace-Forwarded-For'
        ],
        proxyResponseHeaders: ['all'],
        localSdpB: response.sdp,
        localSdpA: async(sdp, res) => {
          this.rtpEngineOpts.uac.tag = res.getParsedHeader('To').params.tag;
          const opts = {
            ...this.rtpEngineOpts.common,
            ...this.rtpEngineOpts.uas.mediaOpts,
            'from-tag': this.rtpEngineOpts.uas.tag,
            'to-tag': this.rtpEngineOpts.uac.tag,
            sdp
          };
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
      debug('call connected successfully to feature server');
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

  _setDlgHandlers(dlg) {
    const {callId} = dlg.sip;
    this.activeCallIds.set(callId, this);
    this.subscribeDTMF(this.logger, callId, this.rtpEngineOpts.uas.tag,
      this._onDTMF.bind(this));
    dlg.on('destroy', () => {
      debug('call ended with normal termination');
      this.logger.info('call ended with normal termination');
      this.rtpEngineResource.destroy().catch((err) => {});
      this.activeCallIds.delete(callId);
      if (dlg.other && dlg.other.connected) dlg.other.destroy().catch((e) => {});
    });

    //re-invite
    dlg.on('modify', this._onReinvite.bind(this, dlg));
  }

  _setHandlers({uas, uac}) {
    this.emit('connected');
    const callStart = Date.now();
    const tags = ['accepted:yes', 'sipStatus:200', `originator:${this.req.locals.originator}`];
    this.stats.increment('sbc.terminations', tags);
    this.activeCallIds.set(this.req.get('Call-ID'), this);
    if (this.req.locals.cdr) {
      this.req.locals.cdr = {
        ...this.req.locals.cdr,
        answered: true,
        answered_at: callStart
      };
    }
    this.uas = uas;
    this.uac = uac;
    [uas, uac].forEach((dlg) => {
      dlg.on('destroy', () => {
        this.logger.info('call ended with normal termination');
        this.rtpEngineResource.destroy().catch((err) => {});
        this.activeCallIds.delete(this.req.get('Call-ID'));
        dlg.other.destroy().catch((e) => {});
        this.unsubscribeDTMF(this.logger, this.req.get('Call-ID'), this.rtpEngineOpts.uas.tag);
        if (process.env.JAMBONES_HOSTING) {
          this.decrKey(this.callCountKey)
            .then((count) => this.logger.debug({key: this.callCountKey},
              `after hangup there are ${count} active calls for this account`))
            .catch((err) => this.logger.error({err}, 'Error decrementing call count'));
        }

        /* write cdr for connected call */
        if (this.req.locals.cdr) {
          const now = Date.now();
          const trunk = ['trunk', 'teams'].includes(this.req.locals.originator) ?
            this.req.locals.carrier :
            this.req.locals.originator;
          this.writeCdrs({...this.req.locals.cdr,
            terminated_at: now,
            termination_reason: dlg.type === 'uas' ? 'caller hungup' : 'called party hungup',
            sip_status: 200,
            duration: Math.floor((now - callStart) / 1000),
            trunk
          }).catch((err) => this.logger.error({err}, 'Error writing cdr for completed call'));
        }
      });
    });

    this.subscribeDTMF(this.logger, this.req.get('Call-ID'), this.rtpEngineOpts.uas.tag,
      this._onDTMF.bind(this, uac));

    uas.on('modify', this._onReinvite.bind(this, uas));
    uac.on('modify', this._onReinvite.bind(this, uac));

    uac.on('refer', this._onFeatureServerTransfer.bind(this, uac));
    uas.on('refer', this._onRefer.bind(this, uas));

    uas.on('info', this._onInfo.bind(this, uas));
    uac.on('info', this._onInfo.bind(this, uac));

    // default forwarding of other request types
    forwardInDialogRequests(uas, ['notify', 'options', 'message']);
  }

  async _onDTMF(dlg, payload) {
    this.logger.info({payload}, '_onDTMF');
    try {
      let dtmf;
      switch (payload.event) {
        case 10:
          dtmf = '*';
          break;
        case 11:
          dtmf = '#';
          break;
        default:
          dtmf = '' + payload.event;
          break;
      }
      await dlg.request({
        method: 'INFO',
        headers: {
          'Content-Type': 'application/dtmf-relay'
        },
        body: `Signal=${dtmf}
Duration=${payload.duration} `
      });
    } catch (err) {
      this.logger.info({err}, 'Error sending INFO application/dtmf-relay');
    }
  }

  /**
   * handle INVITE with Replaces header from uas side (this will never come from the feature server)
   * @param {*} req incoming request
   * @param {*} res incoming response
   */
  async replaces(req, res) {
    try {
      let opts = Object.assign(this.rtpEngineOpts.offer, {sdp: req.body});
      let response = await this.offer(opts);
      if ('ok' !== response.result) {
        res.send(488);
        throw new Error(`replaces: rtpengine failed: offer: ${JSON.stringify(response)}`);
      }
      this.logger.info({opts, response}, 'sent offer for reinvite to rtpengine');
      const sdp = await this.uac.modify(response.sdp);
      opts = Object.assign(this.rtpEngineOpts.answer, {sdp, 'to-tag': this.toTag});
      Object.assign(this.rtpEngineOpts.offer, {'to-tag': this.toTag});
      response = await this.answer(opts);
      if ('ok' !== response.result) {
        res.send(488);
        throw new Error(`replaces: rtpengine failed: ${JSON.stringify(response)}`);
      }
      this.logger.info({opts, response}, 'sent answer for reinvite to rtpengine');
      const headers = {};
      if (this.req.locals.msTeamsTenantFqdn) {
        Object.assign(headers, {'X-MS-Teams-Tenant-FQDN': this.req.locals.msTeamsTenantFqdn});

        // for Microsoft Teams the Contact header must include the tenant FQDN
        Object.assign(headers, {
          Allow: 'INVITE, ACK, OPTIONS, CANCEL, BYE, NOTIFY',
          Contact: `sip:${this.req.locals.msTeamsTenantFqdn}`
        });
      }

      this.unsubscribeDTMF(this.logger, this.req.get('Call-ID'), this.rtpEngineOpts.uas.tag);

      const uas = await this.srf.createUAS(req, res, {
        localSdp: response.sdp,
        headers
      });
      this.logger.info('successfully connected new INVITE w/replaces, hanging up leg being replaced');
      this.uas.destroy();
      this.req = req;
      this.uas = uas;
      this.uas.other = this.uac;
      this.uac.other = this.uas;
      this.activeCallIds.delete(this.req.get('Call-ID'));
      this._setDlgHandlers(uas);
    } catch (err) {
      this.logger.error(err, 'Error handling invite with replaces');
      res.send(err.status || 500);
    }
  }

  async _onReinvite(dlg, req, res) {
    try {
      /* check for re-invite with no SDP -- seen that from BT when they provide UUI info */
      if (!req.body) {
        this.logger.info('got a reINVITE with no SDP; just respond with our current offer');
        res.send(200, {body: dlg.local.sdp});
        return;
      }
      const reason = req.get('X-Reason');
      const fromTag = dlg.type === 'uas' ? this.rtpEngineOpts.uas.tag : this.rtpEngineOpts.uac.tag;
      const toTag = dlg.type === 'uas' ? this.rtpEngineOpts.uac.tag : this.rtpEngineOpts.uas.tag;
      const offerMedia = dlg.type === 'uas' ? this.rtpEngineOpts.uac.mediaOpts : this.rtpEngineOpts.uas.mediaOpts;
      const answerMedia = dlg.type === 'uas' ? this.rtpEngineOpts.uas.mediaOpts : this.rtpEngineOpts.uac.mediaOpts;
      const direction =  dlg.type === 'uas' ? ['public', 'private'] : ['private', 'public'];
      let opts = {
        ...this.rtpEngineOpts.common,
        ...offerMedia,
        'from-tag': fromTag,
        'to-tag': toTag,
        direction,
        sdp: req.body,
      };
      if (reason) opts.flags.push('reset');

      let response = await this.offer(opts);
      if ('ok' !== response.result) {
        res.send(488);
        throw new Error(`_onReinvite: rtpengine failed: offer: ${JSON.stringify(response)}`);
      }

      /* if this is a re-invite from the FS to change media anchoring, avoid sending the reinvite out */
      let sdp;
      if (reason && dlg.type === 'uac' && ['release-media', 'anchor-media'].includes(reason)) {
        this.logger.info(`got a reinvite from FS to ${reason}`);
        sdp = dlg.other.remote.sdp;
      }
      else {
        sdp = await dlg.other.modify(response.sdp);
      }
      opts = {
        ...this.rtpEngineOpts.common,
        ...answerMedia,
        'from-tag': fromTag,
        'to-tag': toTag,
        sdp
      };
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

  async _onInfo(dlg, req, res) {
    const fromTag = dlg.type === 'uas' ? this.rtpEngineOpts.uas.tag : this.rtpEngineOpts.uac.tag;
    try {
      if (dlg.type === 'uac' && req.has('X-Reason')) {
        const reason = req.get('X-Reason');
        const opts = {
          ...this.rtpEngineOpts.common,
          flags: ['reset'],
          'from-tag': fromTag
        };
        this.logger.info(`_onInfo: got request ${reason}`);
        res.send(200);

        if (reason.startsWith('mute')) {
          const response = Promise.all([this.blockMedia(opts), this.blockDTMF(opts)]);
          this.logger.info({response}, `_onInfo: response to rtpengine command for ${reason}`);
        }
        else if (reason.startsWith('unmute')) {
          const response = Promise.all([this.unblockMedia(opts), this.unblockDTMF(opts)]);
          this.logger.info({response}, `_onInfo: response to rtpengine command for ${reason}`);
        }
      }
      else {
        const immutableHdrs = ['via', 'from', 'to', 'call-id', 'cseq', 'max-forwards', 'content-length'];
        const headers = {};
        Object.keys(req.headers).forEach((h) => {
          if (!immutableHdrs.includes(h)) headers[h] = req.headers[h];
        });
        const response = await dlg.other.request({method: 'INFO', headers, body: req.body});
        const responseHeaders = {};
        if (response.has('Content-Type')) {
          Object.assign(responseHeaders, {'Content-Type': response.get('Content-Type')});
        }
        res.send(response.status, {headers: responseHeaders, body: response.body});
      }
    } catch (err) {
      this.logger.info({err}, `Error handing INFO request on ${dlg.type} leg`);
    }
  }

  async _onFeatureServerTransfer(dlg, req, res) {
    try {
      const referTo = req.getParsedHeader('Refer-To');
      const uri = parseUri(referTo.uri);
      this.logger.info({uri, referTo, headers: req.headers}, 'received REFER from feature server');
      const arr = /context-(.*)/.exec(uri.user);
      if (!arr) {
        /* call transfer requested */
        const {gateway} = this.req.locals;
        const referredBy = req.getParsedHeader('Referred-By');
        if (!referredBy) return res.send(400);
        const u = parseUri(referredBy.uri);

        let selectedGateway = false;
        let e164 = false;
        if (gateway) {
          /* host of Refer-to to an outbound gateway */
          const gw = await this.srf.locals.getOutboundGatewayForRefer(gateway.voip_carrier_sid);
          if (gw) {
            selectedGateway = true;
            e164 = gw.e164_leading_plus;
            uri.host = gw.ipv4;
            uri.port = gw.port;
          }
        }
        if (!selectedGateway) {
          uri.host = this.req.source_address;
          uri.port = this.req.source_port;
        }
        if (e164 && !uri.user.startsWith('+')) {
          uri.user = `+${uri.user}`;
        }
        const response = await this.uas.request({
          method: 'REFER',
          headers: {
            'Refer-To': stringifyUri(uri),
            'Referred-By': stringifyUri(u)
          }
        });
        return res.send(response.status);
      }
      res.send(202);

      // invite to new fs
      const headers = {};
      if (req.has('X-Retain-Call-Sid')) {
        Object.assign(headers, {'X-Retain-Call-Sid': req.get('X-Retain-Call-Sid')});
      }
      const uac = await this.srf.createUAC(referTo.uri, {localSdp: dlg.local.sdp, headers});
      this.uac = uac;
      uac.other = this.uas;
      this.uas.other = uac;
      uac.on('modify', this._onFeatureServerReinvite.bind(this, uac));
      uac.on('refer', this._onFeatureServerTransfer.bind(this, uac));
      uac.on('destroy', () => {
        this.logger.info('call ended with normal termination');
        this.rtpEngineResource.destroy();
        this.activeCallIds.delete(this.req.get('Call-ID'));
        uac.other.destroy();
      });
      // now we can destroy the old dialog
      dlg.destroy().catch(() => {});

      // modify rtpengine to stream to new feature server
      const opts = Object.assign({sdp: uac.remote.sdp, 'to-tag': res.getParsedHeader('To').params.tag},
        this.rtpEngineOpts.answer);
      const response = await this.answer(opts);
      if ('ok' !== response.result) {
        res.send(488);
        throw new Error(`_onFeatureServerReinvite: rtpengine failed: ${JSON.stringify(response)}`);
      }
      this.logger.info('successfully moved call to new feature server');
    } catch (err) {
      this.logger.error(err, 'Error handling refer from feature server');
    }
  }


  async _onRefer(dlg, req, res) {
    const ua = req.get('User-Agent');
    const referTo = req.get('Refer-To');
    const rt = req.getParsedHeader('Refer-To');
    const uri = parseUri(rt.uri);
    this.logger.info({referTo, ua, rt, uri}, 'got a REFER');

    /**
     * send NOTIFY of INVITE status, return true if call answered
     */
    const sendNotify = (dlg, body) => {
      const arr = /SIP\/2.0\s+(\d+).*$/.exec(body);
      const status = arr ? parseInt(arr[1]) : null;
      dlg.request({
        method: 'NOTIFY',
        headers: {
          'Content-Type': 'message/sipfrag;version=2.0',
          'Contact': `sip:${this.req.locals.msTeamsTenantFqdn}`
        },
        body
      });
      this.logger.info(`sent NOTIFY for REFER with status ${status}`);
      return status === 200;
    };

    if (this.isFromMSTeams && ua.startsWith(MS_TEAMS_USER_AGENT) &&
      referTo.startsWith(`<sip:${MS_TEAMS_SIP_ENDPOINT}`) &&
      !uri.user) {

      // the Refer-To endpoint is within Teams itself, so we can handle
      res.send(202);
      try {
        const dlg = await this.srf.createUAC(rt.uri, {
          localSdp: this.uas.local.sdp.replace(/a=inactive/g, 'a=sendrecv'),
          headers: {
            'From': `sip:${this.req.callingNumber}@${this.req.locals.msTeamsTenantFqdn}`,
            'Contact': `sip:${this.req.callingNumber}@${this.req.locals.msTeamsTenantFqdn}`
          }
        },
        {
          cbRequest: (err, inviteSent) => {
            if (err) return sendNotify(this.uas, `SIP/2.0 ${err.status || '500'}`);
            sendNotify(this.uas, '100 Trying ');
            this.referInvite = inviteSent;
          },
          cbProvisional: (prov) => {
            sendNotify(this.uas, `${prov.status} ${prov.reason}`);
          }
        });

        // successfully connected
        this.logger.info('successfully connected new call leg for REFER');
        this.unsubscribeDTMF(this.logger, this.req.get('Call-ID'), this.rtpEngineOpts.uas.tag);
        this.referInvite = null;
        sendNotify(this.uas, '200 OK');
        this.uas.destroy();
        this.uas = dlg;
        this.uas.other = this.uac;
        this.activeCallIds.delete(this.req.get('Call-ID'));
        this._setDlgHandlers(dlg);
      } catch (err) {
        this.logger.error({err}, 'Error creating new call leg for REFER');
        sendNotify(this.uas, `${err.status || 500} ${err.reason || ''}`);
      }
    }
    else {
      // TODO: forward on to feature server
      res.send(501);
    }
  }

}

module.exports = CallSession;
