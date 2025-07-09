const Emitter = require('events');
const SrsClient = require('@jambonz/siprec-client-utils');
const {
  makeRtpEngineOpts,
  SdpWantsSrtp,
  SdpWantsSDES,
  nudgeCallCounts,
  roundTripTime,
  parseConnectionIp,
  isPrivateVoipNetwork,
  makeFullMediaReleaseKey,
  makePartnerFullMediaReleaseKey
} = require('./utils');
const { MediaPath } = require('./constants.json');

const {forwardInDialogRequests} = require('drachtio-fn-b2b-sugar');
const {parseUri, stringifyUri, SipError} = require('drachtio-srf');
const debug = require('debug')('jambonz:sbc-inbound');
const MS_TEAMS_USER_AGENT = 'Microsoft.PSTNHub.SIPProxy';
const MS_TEAMS_SIP_ENDPOINT = 'sip.pstnhub.microsoft.com';
const IMMUTABLE_HEADERS = ['via', 'from', 'to', 'call-id', 'cseq', 'max-forwards', 'content-length'];

/**
 * this is to make sure the outgoing From has the number in the incoming From
 * and not the incoming PAI
 */
const createBLegFromHeader = (req) => {
  const from = req.getParsedHeader('From');
  const uri = parseUri(from.uri);
  const name = from.name;
  const displayName = name ? `${name} ` : '';
  if (uri && uri.user) return `${displayName}<sip:${uri.user}@localhost>`;
  else return `${displayName}<sip:anonymous@localhost>`;
};

const createSiprecBody = (headers, sdp, type, content) => {
  const sep = 'uniqueBoundary';
  headers['Content-Type'] = `multipart/mixed;boundary="${sep}"`;
  return `--${sep}\r
Content-Type: application/sdp\r
\r
${sdp}\r
--${sep}\r
Content-Type: ${type}\r
Content-Disposition: recording-session\r
\r
${content}`;
};

class CallSession extends Emitter {
  constructor(logger, req, res) {
    super();
    this.req = req;
    this.res = res;
    this.srf = req.srf;
    this.logger = logger.child({callId: req.get('Call-ID')});
    this.siprec = req.locals.siprec;
    this.xml = req.locals.xml;

    this.getRtpEngine = req.srf.locals.getRtpEngine;
    this.getFeatureServer = req.srf.locals.getFeatureServer;
    this.stats = this.srf.locals.stats;
    this.writeCdrs = this.srf.locals.writeCdrs;
    this.activeCallIds = this.srf.locals.activeCallIds;

    this.decrKey = req.srf.locals.realtimeDbHelpers.decrKey;
    this.addKey = req.srf.locals.realtimeDbHelpers.addKey;
    this.retrieveKey = req.srf.locals.realtimeDbHelpers.retrieveKey;

    this._mediaPath = MediaPath.FullMedia;

    this.application_sid = req.locals.application_sid;
    this.account_sid = req.locals.account_sid;
    this.service_provider_sid = req.locals.service_provider_sid;
    this.srsClients = [];
    this.recordingNoAnswerTimeout = (process.env.JAMBONES_RECORDING_NO_ANSWER_TIMEOUT || 2) * 1000;
  }

  get isFromMSTeams() {
    return !!this.req.locals.msTeamsTenantFqdn;
  }

  get privateSipAddress() {
    return this.srf.locals.privateSipAddress;
  }

  get isMediaReleased() {
    return this._mediaPath !== MediaPath.FullMedia;
  }

  get isFive9VoiceStream() {
    return this.req.has('X-Five9-StreamingPairId');
  }

  subscribeForDTMF(dlg) {
    if (!this._subscribedForDTMF) {
      this._subscribedForDTMF = true;
      this.subscribeDTMF(this.logger, this.req.get('Call-ID'), this.rtpEngineOpts.uas.tag,
        this._onDTMF.bind(this, dlg));
    }
  }
  unsubscribeForDTMF() {
    if (this._subscribedForDTMF) {
      this._subscribedForDTMF = false;
      this.unsubscribeDTMF(this.logger, this.req.get('Call-ID'), this.rtpEngineOpts.uas.tag);
    }
  }

  async connect() {
    const {sdp} = this.req.locals;
    const is3pcc = this.req.body?.length === 0;
    this.logger.info(`inbound ${is3pcc ? '3pcc ' : ''}call accepted for routing`);
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
      query,
      blockMedia,
      unblockMedia,
      blockDTMF,
      unblockDTMF,
      playDTMF,
      subscribeDTMF,
      unsubscribeDTMF,
      subscribeRequest,
      subscribeAnswer,
      unsubscribe
    } = engine;
    this.offer = offer;
    this.answer = answer;
    this.del = del;
    this.query = query;
    this.blockMedia = blockMedia;
    this.unblockMedia = unblockMedia;
    this.blockDTMF = blockDTMF;
    this.unblockDTMF = unblockDTMF;
    this.playDTMF = playDTMF;
    this.subscribeDTMF = subscribeDTMF;
    this.unsubscribeDTMF = unsubscribeDTMF;
    this.subscribeRequest = subscribeRequest;
    this.subscribeAnswer = subscribeAnswer;
    this.unsubscribe = unsubscribe;

    const featureServer = await this.getFeatureServer();
    if (!featureServer) {
      this.logger.info('No available feature servers, rejecting call!');
      const tags = ['accepted:no', 'sipStatus:480', `originator:${this.req.locals.originator}`];
      this.stats.increment('sbc.terminations', tags);
      return this.res.send(480);
    }
    this.logger.debug(`using feature server ${featureServer}`);

    const wantsSrtp = this.req.locals.possibleWebRtcClient = SdpWantsSrtp(sdp);
    const wantsSDES = SdpWantsSDES(sdp);
    this.rtpEngineOpts = makeRtpEngineOpts(this.req, wantsSrtp, false, this.isFromMSTeams || wantsSDES);
    this.rtpEngineResource = {
      destroy: this.del.bind(null, this.rtpEngineOpts.common),
      query: this.query.bind(null, this.rtpEngineOpts.common),
    };
    const obj = parseUri(this.req.uri);
    let proxy, host, uri;

    const scheme = obj.scheme;

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
    if (obj.user) uri = `sip:${obj.user}@${host}`;
    else uri = `sip:${host}`;
    this.logger.info(`uri will be: ${uri}, proxy ${proxy}`);

    const sendOfferToRtpEngine = async(remoteSdp) => {
      const opts = {
        ...this.rtpEngineOpts.common,
        ...this.rtpEngineOpts.uac.mediaOpts,
        'from-tag': this.rtpEngineOpts.uas.tag,
        direction:  [isPrivateVoipNetwork(this.req.source_address) ? 'private' : 'public', 'private'],
        sdp: remoteSdp
      };
      const startAt = process.hrtime();
      const response = await this.offer(opts);
      this.rtpengineIp = opts.sdp ? parseConnectionIp(opts.sdp) : 'undefined';
      const rtt = roundTripTime(startAt);
      this.stats.histogram('app.rtpengine.response_time', rtt, [
        'direction:inbound', 'command:offer', `rtpengine:${this.rtpengineIp}`]);
      this.logger.debug({opts, response, rtt, rtpengine: this.rtpengineIp}, 'response from rtpengine to offer');
      if ('ok' !== response.result) {
        this.logger.error({}, `rtpengine offer failed with ${JSON.stringify(response)}`);
        throw new Error('rtpengine failed: answer');
      }
      return response;
    };

    try {
      const response = await sendOfferToRtpEngine(sdp);
      let headers = {
        'From': createBLegFromHeader(this.req),
        'To': this.req.get('To'),
        'X-Account-Sid': this.req.locals.account_sid,
        'X-CID': this.req.get('Call-ID'),
        'X-Forwarded-For': `${this.req.source_address}`
      };
      if (this.privateSipAddress) headers = {...headers, Contact: `<sip:${this.privateSipAddress}>`};

      let spdOfferB;
      if (this.siprec && this.xml) {
        spdOfferB = createSiprecBody(headers, response.sdp, this.xml.type, this.xml.content);
      }
      else if (!is3pcc) {
        spdOfferB = response.sdp;
      }

      if (this.req.locals.carrier) {
        Object.assign(headers, {
          'X-Originating-Carrier': this.req.locals.carrier,
          'X-Voip-Carrier-Sid': this.req.locals.voip_carrier_sid
        });
      }

      // set Contact header based on scenario, and transport protocol
      let responseHeaders = {};
      if (isPrivateVoipNetwork(this.req.source_address)) {
        this.contactHeader = `<${scheme}:${this.privateSipAddress};transport=${this.req.protocol}>`;
        responseHeaders = {
          ...responseHeaders,
          'Contact': this.contactHeader
        };
      } else if (this.req.locals.msTeamsTenantFqdn) {
        Object.assign(headers, {'X-MS-Teams-Tenant-FQDN': this.req.locals.msTeamsTenantFqdn});

        // for Microsoft Teams the Contact header must include the tenant FQDN
        this.contactHeader = `sip:${this.req.locals.msTeamsTenantFqdn}`;
        responseHeaders = {
          ...responseHeaders,
          Allow: 'INVITE, ACK, OPTIONS, CANCEL, BYE, NOTIFY, UPDATE, PRACK',
          Contact: this.contactHeader
        };
      }
      else {
        const hostport = this.srf.locals.sbcPublicIpAddress[this.req.protocol];
        this.contactHeader = `<${scheme}:${hostport};transport=${this.req.protocol}>`;
        responseHeaders = {
          ...responseHeaders,
          'Contact': this.contactHeader
        };
      }
      if (this.req.locals.application_sid) {
        Object.assign(headers, {'X-Application-Sid': this.req.locals.application_sid});
      }
      if (this.req.authorization) {
        if (this.req.authorization.grant && this.req.authorization.grant.application_sid) {
          Object.assign(headers, {'X-Application-Sid': this.req.authorization.grant.application_sid});
        }
        if (this.req.authorization.challengeResponse) {
          const {username, realm} = this.req.authorization.challengeResponse;
          Object.assign(headers, {'X-Authenticated-User': `${username}@${realm}`});
        }
      }

      if (this.req.canceled) throw new Error('call canceled');

      // now send the INVITE in towards the feature servers
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
          '-X-Application-Sid',
          '-X-Authenticated-User'
        ],
        proxyResponseHeaders: ['all', '-X-Trace-ID'],
        localSdpB: spdOfferB ? spdOfferB : async(ackBody) => {
          const response = await sendOfferToRtpEngine(ackBody);
          return response.sdp;
        },
        localSdpA: async(sdp, res) => {
          this.rtpEngineOpts.uac.tag = res.getParsedHeader('To').params.tag;
          const opts = {
            ...this.rtpEngineOpts.common,
            ...this.rtpEngineOpts.uas.mediaOpts,
            'from-tag': this.rtpEngineOpts.uas.tag,
            'to-tag': this.rtpEngineOpts.uac.tag,
            sdp
          };
          const startAt = process.hrtime();
          const aOpts = {
            ...opts,
            ...(is3pcc && {direction: ['private', 'public']})
          };
          const response = await this.answer(aOpts);
          this.logger.debug({response, opts: aOpts}, 'response from rtpengine to answer');
          const rtt = roundTripTime(startAt);
          this.stats.histogram('app.rtpengine.response_time', rtt, [
            'direction:inbound', 'command:answer', `rtpengine:${this.rtpengineIp}`]);
          if ('ok' !== response.result) {
            this.logger.error(`rtpengine answer failed with ${JSON.stringify(response)}`);
            throw new Error('rtpengine failed: answer');
          }
          /* special case: Five9 Voicestream calls do not advertise a:sendonly, though they should */
          if (this.isFive9VoiceStream) {
            const opts = {
              ...this.rtpEngineOpts.common,
              'from-tag':this.rtpEngineOpts.uac.tag
            };
            this.logger.info('Voicestream call from Five9, blocking audio in the reverse direction');
            const response = await Promise.all([this.blockMedia(opts), this.blockDTMF(opts)]);
            this.logger.debug({response}, 'response to blockMedia/blockDTMF');
          }

          return response.sdp;
        },
      });

      // successfully connected
      this.logger.info('call connected successfully to feature server');
      debug('call connected successfully to feature server');
      this._setHandlers({uas, uac});
      return;
    } catch (err) {
      this.rtpEngineResource.destroy().catch((err) => this.logger.info({err}, 'Error destroying rtpe after failure'));
      this.activeCallIds.delete(this.req.get('Call-ID'));
      if (err instanceof SipError) {
        const tags = ['accepted:no', `sipStatus:${err.status}`, `originator:${this.req.locals.originator}`];
        this.stats.increment('sbc.terminations', tags);
        this.logger.info(`call failed to connect to feature server with ${err.status}`);
        this.emit('failed');
      }
      else if (err.message !== 'call canceled') {
        const {writeCallCount, writeCallCountSP, writeCallCountApp} = this.req.srf.locals;
        this.logger.error(err, 'unexpected error routing inbound call');
        nudgeCallCounts(this.req, 'failure', {
          service_provider_sid: this.service_provider_sid,
          account_sid: this.account_sid,
          application_sid: this.application_sid,
          callId: this.req.locals.callId
        }, this.decrKey, {writeCallCountSP, writeCallCount, writeCallCountApp})
          .catch((err) => this.logger.error(err, 'Error decrementing call counts'));

      }
      this.srf.endSession(this.req);
    }
  }

  _setDlgHandlers(dlg) {
    const {callId} = dlg.sip;
    this.activeCallIds.set(callId, this);
    this.subscribeForDTMF(this.uac);
    dlg.on('destroy', () => {
      debug('call ended with normal termination');
      this.logger.info('call ended with normal termination');
      this.rtpEngineResource.destroy().catch((err) => {});
      this.activeCallIds.delete(callId);
      if (dlg.other && dlg.other.connected) dlg.other.destroy().catch((e) => {});

      this._stopRecording();

      this.srf.endSession(this.req);
    });

    //re-invite
    dlg.on('modify', this._onReinvite.bind(this, dlg));
  }

  _startRecordingNoAnswerTimer(res) {
    this._clearRecordingNoAnswerTimer();
    this.recordingNoAnswerTimer = setTimeout(() => {
      this.logger.info('No response from SipRec server, return error to feature server');
      this.isRecordingNoAnswerResponded = true;
      res.send(400);
    }, this.recordingNoAnswerTimeout);
  }

  _clearRecordingNoAnswerTimer() {
    if (this.recordingNoAnswerTimer) {
      clearTimeout(this.recordingNoAnswerTimer);
      this.recordingNoAnswerTimer = null;
    }
  }

  _stopRecording() {
    if (this.srsClients.length) {
      this.srsClients.forEach((c) => c.stop());
      this.srsClients = [];
    }
  }

  _setHandlers({uas, uac}) {
    this.emit('connected');
    const callStart = Date.now();
    const call_sid = uac.res?.get('X-Call-Sid');
    const application_sid = this.application_sid || uac.res?.get('X-Application-Sid');
    const tags = ['accepted:yes', 'sipStatus:200', `originator:${this.req.locals.originator}`];
    this.stats.increment('sbc.terminations', tags);
    this.activeCallIds.set(this.req.get('Call-ID'), this);
    if (this.req.locals.cdr) {
      this.req.locals.cdr = {
        ...this.req.locals.cdr,
        answered: true,
        answered_at: callStart,
        ...(call_sid && {call_sid}),
        ...(application_sid && {application_sid}),
        trace_id: uac.res?.get('X-Trace-ID') || '00000000000000000000000000000000'
      };
    }

    /* save far end SDP for later use if we do a full media release */
    if (process.env.JAMBONES_ENABLE_FULL_MEDIA_RELEASE) {
      const key = makeFullMediaReleaseKey(this.req.get('Call-ID'));
      const sdp = this.req.body;
      this.logger.info({key, sdp}, 'saving far end sdp for full media release feature');
      this.addKey(key, sdp, 3600).catch((err) => this.logger.error(err, 'Error saving far end sdp'));
    }
    this.uas = uas;
    this.uac = uac;
    [uas, uac].forEach((dlg) => {
      dlg.on('destroy', async(bye) => {
        const other = dlg.other;
        this.rtpEngineResource.destroy().catch((err) => {});
        /* DH: need a better understanding of why query before delete is a good idea
        this.rtpEngineResource.query()
          .then((results) => {
            this.logger.info({results}, 'rtpengine query results');
            return this.rtpEngineResource.destroy();
          })
          .catch((err) => {});
        */
        this.activeCallIds.delete(this.req.get('Call-ID'));
        try {
          const headers = {};
          Object.keys(bye.headers).forEach((h) => {
            if (!IMMUTABLE_HEADERS.includes(h)) headers[h] = bye.headers[h];
          });
          await other.destroy({headers});
        } catch (err) {}
        this.unsubscribeForDTMF();


        const trackingOn = process.env.JAMBONES_TRACK_ACCOUNT_CALLS ||
          process.env.JAMBONES_TRACK_SP_CALLS ||
          process.env.JAMBONES_TRACK_APP_CALLS;

        if (process.env.JAMBONES_HOSTING || trackingOn) {
          const {writeCallCount, writeCallCountSP, writeCallCountApp} = this.req.srf.locals;
          if (!this.req.locals.callCountNudged) {
            this.req.locals.callCountNudged = true;
            this.logger.debug('decrementing call count at end of call');
            await nudgeCallCounts(this.req, 'complete', {
              service_provider_sid: this.service_provider_sid,
              account_sid: this.account_sid,
              application_sid: this.application_sid,
              callId: this.req.locals.callId
            }, this.decrKey, {writeCallCountSP, writeCallCount, writeCallCountApp})
              .catch((err) => this.logger.error(err, 'Error decrementing call counts'));
          }
        }

        /* write cdr for connected call */
        if (this.req.locals.cdr) {
          const now = Date.now();
          const trunk = ['trunk', 'teams'].includes(this.req.locals.originator) ?
            this.req.locals.carrier :
            this.req.locals.originator;
          const application = await this.srf.locals.getApplicationBySid(application_sid);
          const isRecording = this.req.locals.account.record_all_calls || (application && application.record_all_calls);
          const day = new Date();
          let recording_url = `/Accounts/${this.account_sid}/RecentCalls/${call_sid}/record`;
          recording_url += `/${day.getFullYear()}/${(day.getMonth() + 1).toString().padStart(2, '0')}`;
          recording_url += `/${day.getDate().toString().padStart(2, '0')}/${this.req.locals.account.record_format}`;
          const cdr = {...this.req.locals.cdr,
            terminated_at: now,
            termination_reason: dlg.type === 'uas' ? 'caller hungup' : 'called party hungup',
            sip_status: 200,
            duration: Math.floor((now - callStart) / 1000),
            trunk,
            ...(isRecording && {recording_url})
          };
          this.logger.info({cdr}, 'going to write a cdr now..');
          this.writeCdrs({...this.req.locals.cdr,
            terminated_at: now,
            termination_reason: dlg.type === 'uas' ? 'caller hungup' : 'called party hungup',
            sip_status: 200,
            duration: Math.floor((now - callStart) / 1000),
            trunk,
            ...(isRecording && {recording_url})
          })
            .then(() => this.logger.debug('successfully wrote cdr'))
            .catch((err) => this.logger.error({err}, 'Error writing cdr for completed call'));
        }
        /* de-link the 2 Dialogs for GC */
        dlg.removeAllListeners();
        other.removeAllListeners();
        dlg.other = null;
        other.other = null;

        this._stopRecording();

        this.logger.info(`call ended with normal termination, there are ${this.activeCallIds.size} active`);
        this.srf.endSession(this.req);
      });
    });

    this.subscribeForDTMF(uac);

    uas.on('modify', this._onReinvite.bind(this, uas));
    uac.on('modify', this._onReinvite.bind(this, uac));

    uac.on('refer', this._onFeatureServerTransfer.bind(this, uac));
    uas.on('refer', this._onRefer.bind(this, uas));

    uas.on('info', this._onInfo.bind(this, uas));
    uac.on('info', this._onInfo.bind(this, uac));

    // default forwarding of other request types
    forwardInDialogRequests(uas, ['notify', 'options', 'message']);

    // we need special handling for invite with null sdp followed by 3pcc re-invite
    if (uas.local.sdp.includes('a=recvonly') || uas.local.sdp.includes('a=inactive')) {
      this.logger.info('incoming call is recvonly or inactive, waiting for re-invite');
      this._recvonly = true;
    }
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
      const fromTag = this.rtpEngineOpts.uas.tag;
      const toTag =  this.rtpEngineOpts.uac.tag;
      const offerMedia = this.rtpEngineOpts.uac.mediaOpts;
      const answerMedia = this.rtpEngineOpts.uas.mediaOpts;
      const direction = ['public', 'private'];
      let opts = {
        ...this.rtpEngineOpts.common,
        ...offerMedia,
        'from-tag': fromTag,
        'to-tag': toTag,
        direction,
        sdp: req.body,
      };
      let response = await this.offer(opts);
      if ('ok' !== response.result) {
        res.send(488);
        throw new Error(`replaces: rtpengine failed: offer: ${JSON.stringify(response)}`);
      }
      this.logger.info({opts, response}, 'sent offer for reinvite to rtpengine');
      const sdp = await this.uac.modify(response.sdp);
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

      this.unsubscribeForDTMF();

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
    const fromTag = dlg.type === 'uas' ? this.rtpEngineOpts.uas.tag : this.rtpEngineOpts.uac.tag;
    const toTag = dlg.type === 'uas' ? this.rtpEngineOpts.uac.tag : this.rtpEngineOpts.uas.tag;
    const reason = req.get('X-Reason');
    const isReleasingMedia = reason && dlg.type === 'uac' && ['release-media', 'anchor-media'].includes(reason);
    const isFullMediaRelease = reason === 'release-media-entirely' && process.env.JAMBONES_ENABLE_FULL_MEDIA_RELEASE;
    const offerMedia = dlg.type === 'uas' ? this.rtpEngineOpts.uac.mediaOpts : this.rtpEngineOpts.uas.mediaOpts;
    const answerMedia = dlg.type === 'uas' ? this.rtpEngineOpts.uas.mediaOpts : this.rtpEngineOpts.uac.mediaOpts;
    const direction =  dlg.type === 'uas' ? ['public', 'private'] : ['private', 'public'];

    try {
      /* check for re-invite with no SDP -- seen that from BT when they provide UUI info */
      if (!req.body) {
        if (dlg.type === 'uas' && this._recvonly) {
          /* seen this from Broadworks - initial INVITE has no SDP, then reINVITE with SDP */
          this._recvonly = false;  //one-time only
          const myMungedSdp = dlg.local.sdp.replace('a=recvonly', 'a=sendrecv').replace('a=inactive', 'a=sendrecv');
          this.logger.info({myMungedSdp}, '_onReinvite (3gpp): got a reINVITE with no SDP while in recvonly mode');
          res.send(200,
            {
              body: myMungedSdp
            },
            (err, req) => {},
            async(ack) => {
              const remoteOffer = ack.body;
              this.logger.info({remoteOffer}, '_onReinvite (3gpp): got ACK for reINVITE with SDP');
              let opts = {
                ...this.rtpEngineOpts.common,
                ...offerMedia,
                'from-tag': fromTag,
                'to-tag': toTag,
                direction,
                sdp: remoteOffer,
              };
              let response = await this.offer(opts);
              if ('ok' !== response.result) {
                res.send(488);
                throw new Error(`_onReinvite (3gpp): rtpengine failed: offer: ${JSON.stringify(response)}`);
              }
              this.logger.info({response}, '_onReinvite (3gpp): response from rtpengine for offer');
              const fsSdp = await dlg.other.modify(response.sdp);
              opts = {
                ...this.rtpEngineOpts.common,
                ...answerMedia,
                'from-tag': fromTag,
                'to-tag': toTag,
                sdp: fsSdp
              };
              response = await this.answer(opts);
              if ('ok' !== response.result) {
                res.send(488);
                throw new Error(`_onReinvite(3gpp): rtpengine failed answer: ${JSON.stringify(response)}`);
              }
            }
          );
        }
        else {
          this.logger.info('got a reINVITE with no SDP; just respond with our current offer');
          res.send(200, {
            headers: {
              'Contact': this.contactHeader
            },
            body: dlg.local.sdp
          });
        }
        return;
      }

      if (isFullMediaRelease) {
        const b_sdp = await this.retrieveKey(makePartnerFullMediaReleaseKey(this.req.get('Call-ID')));
        this.logger.info({b_sdp}, 'reinvite ourselves out of the media path with this reinvite offer');
        const answerSdp = await dlg.other.modify(b_sdp);
        this.logger.info({answerSdp}, 'far end response to full media release');
        res.send(200, {
          body: dlg.local.sdp,
          headers: {
            'Contact': this.contactHeader
          }
        });
        /* no media going through us now we can destroy the rtpengine resource */
        this.rtpEngineResource.destroy().catch((err) => {
          this.logger.info({err}, 'Error destroying rtpengine resource after full media release');
        });
        this._mediaPath = MediaPath.NoMedia;
        return;
      }

      const offeredSdp = Array.isArray(req.payload) && req.payload.length > 1 ?
        req.payload.find((p) => p.type === 'application/sdp').content :
        req.body;

      if (isReleasingMedia) {
        if (!offerMedia.flags.includes('asymmetric')) offerMedia.flags.push('asymmetric');
        offerMedia.flags = offerMedia.flags.filter((f) => f !== 'media handover');
      }
      let opts = {
        ...this.rtpEngineOpts.common,
        ...offerMedia,
        'from-tag': fromTag,
        'to-tag': toTag,
        direction,
        sdp: offeredSdp,
      };
      // Dont reset ICE - causes audiocodes webrtrc to fail with "missing ice-ufrag and ice-pwd in re-invite"
      // if (reason && opts.flags && !opts.flags.includes('reset')) opts.flags.push('reset');

      let response = await this.offer(opts);
      if ('ok' !== response.result) {
        res.send(488);
        throw new Error(`_onReinvite: rtpengine failed: offer: ${JSON.stringify(response)}`);
      }

      /* if this is a re-invite from the FS to change media anchoring, avoid sending the reinvite out */
      let sdp;
      //HL 2024-11-13: previously forwarded re-invites to webrtc clients but further testing has shown to be unnecessary
      //if (isReleasingMedia && !this.callerIsUsingSrtp) {

      //DH 2024-11- 18: if we are going from no-media to either partial or full media, we need reinvite the far end
      if (isReleasingMedia && this._mediaPath !== MediaPath.NoMedia) {
        sdp = dlg.other.remote.sdp;
        if (!answerMedia.flags.includes('asymmetric')) answerMedia.flags.push('asymmetric');
        answerMedia.flags = answerMedia.flags.filter((f) => f !== 'media handover');
        this._mediaPath = 'release-media' === reason ? MediaPath.PartialMedia : MediaPath.FullMedia;
        this.logger.debug(`media path is now ${this._mediaPath}`);
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
      res.send(200, {
        headers: {
          'Contact': this.contactHeader
        },
        body: response.sdp
      });
    } catch (err) {
      res.send(err.status || 500);
      this.logger.error(err, 'Error handling reinvite');
    }
  }

  async _onInfo(dlg, req, res) {
    const fromTag = dlg.type === 'uas' ? this.rtpEngineOpts.uas.tag : this.rtpEngineOpts.uac.tag;
    const toTag = dlg.type === 'uas' ? this.rtpEngineOpts.uac.tag : this.rtpEngineOpts.uas.tag;
    const contentType = req.get('Content-Type');
    try {
      if (dlg.type === 'uac' && req.has('X-Reason')) {
        const reason = req.get('X-Reason');
        const opts = {
          ...this.rtpEngineOpts.common,
          flags: ['reset'],
          'from-tag': fromTag
        };
        this.logger.info(`_onInfo: got request ${reason}`);

        if (reason.startsWith('mute')) {
          const response = Promise.all([this.blockMedia(opts), this.blockDTMF(opts)]);
          res.send(200);
          this.logger.info({response}, `_onInfo: response to rtpengine command for ${reason}`);
        }
        else if (reason.startsWith('unmute')) {
          const response = Promise.all([this.unblockMedia(opts), this.unblockDTMF(opts)]);
          res.send(200);
          this.logger.info({response}, `_onInfo: response to rtpengine command for ${reason}`);
        }
        else if (reason.includes('CallRecording')) {
          let succeeded = false;
          const headers = contentType === 'application/json' && req.body ? JSON.parse(req.body) : {};
          if (reason === 'startCallRecording') {
            const from = this.req.getParsedHeader('From');
            const to = this.req.getParsedHeader('To');
            const aorFrom = from.uri;
            const aorTo = to.uri;
            this.logger.info({to, from}, 'startCallRecording request for a call');

            const srsUrl = req.get('X-Srs-Url');
            const srsRecordingId = req.get('X-Srs-Recording-ID');
            const callSid = req.get('X-Call-Sid');
            const accountSid = req.get('X-Account-Sid');
            const applicationSid = req.get('X-Application-Sid');
            if (this.srsClients.length) {
              res.send(400);
              this.logger.info('discarding duplicate startCallRecording request for a call');
              return;
            }
            if (!srsUrl) {
              this.logger.info('startCallRecording request is missing X-Srs-Url header');
              res.send(400);
              return;
            }
            const arr = srsUrl.split(',');
            this.srsClients = arr.map((url) => new SrsClient(this.logger, {
              srf: dlg.srf,
              direction: 'inbound',
              originalInvite: this.req,
              callingNumber: this.req.callingNumber,
              calledNumber: this.req.calledNumber,
              srsUrl: url,
              srsRecordingId,
              callSid,
              accountSid,
              applicationSid,
              rtpEngineOpts: this.rtpEngineOpts,
              fromTag,
              toTag,
              aorFrom,
              aorTo,
              subscribeRequest: this.subscribeRequest,
              subscribeAnswer: this.subscribeAnswer,
              del: this.del,
              blockMedia: this.blockMedia,
              unblockMedia: this.unblockMedia,
              unsubscribe: this.unsubscribe,
              headers,
              isSipRecCall: Array.isArray(this.req.payload) && this.req.payload.length > 1
            }));
            try {
              this._startRecordingNoAnswerTimer(res);
              await Promise.any(this.srsClients.map((c) => c.start()));
              succeeded = true;
            } catch (err) {
              this.logger.error({err}, 'Error starting SipRec call recording');
              succeeded = false;
            }
          }
          else if (reason === 'stopCallRecording') {
            if (!this.srsClients.length || !this.srsClients.some((c) => c.activated)) {
              res.send(400);
              this.logger.info('discarding stopCallRecording request because we are not recording');
              return;
            }
            try {
              this._startRecordingNoAnswerTimer(res);
              await Promise.any(this.srsClients.map((c) => {
                if (c.activated) {
                  c.stop();
                }
              }));
              succeeded = true;
            } catch (err) {
              this.logger.error({err}, 'Error stopping SipRec call recording');
              succeeded = false;
            }
            this.srsClients = [];
          }
          else if (reason === 'pauseCallRecording') {
            if (!this.srsClients.length || !this.srsClients.some((c) => c.activated && !c.paused)) {
              this.logger.info('discarding invalid pauseCallRecording request');
              res.send(400);
              return;
            }
            try {
              this._startRecordingNoAnswerTimer(res);
              await Promise.any(this.srsClients.map((c) => {
                if (c.activated && !c.paused) {
                  c.pause({headers});
                }
              }));
              succeeded = true;
            } catch (err) {
              this.logger.error({err}, 'Error pausing SipRec call recording');
              succeeded = false;
            }
          }
          else if (reason === 'resumeCallRecording') {
            if (!this.srsClients.length || !this.srsClients.some((c) => c.activated && c.paused)) {
              res.send(400);
              this.logger.info('discarding invalid resumeCallRecording request');
              return;
            }
            try {
              this._startRecordingNoAnswerTimer(res);
              await Promise.any(this.srsClients.map((c) => {
                if (c.activated && c.paused) {
                  c.resume({headers});
                }
              }));
              succeeded = true;
            } catch (err) {
              this.logger.error({err}, 'Error resuming SipRec call recording');
              succeeded = false;
            }
          }
          if (!this.isRecordingNoAnswerResponded) {
            this._clearRecordingNoAnswerTimer();
            res.send(succeeded ? 200 : 503);
          }
        } else if (reason.includes('Dtmf')) {
          const arr = /Signal=\s*([0-9#*])/.exec(req.body);
          if (!arr) {
            this.logger.info({body: req.body}, '_onInfo: invalid INFO Dtmf');
            throw new Error(`_onInfo: no dtmf in body for ${contentType}`);
          }
          const code = arr[1];
          const arr2 = /Duration=\s*(\d+)/.exec(req.body);
          const duration = arr2 ? arr2[1] : 250;
          const volume = 13;
          const dtmfOpts = {
            ...this.rtpEngineOpts.common,
            'from-tag': this.rtpEngineOpts.uac.tag,
            code,
            duration,
            volume
          };
          const response = await this.playDTMF(dtmfOpts);
          if ('ok' !== response.result) {
            this.logger.info({response}, `rtpengine play Dtmf failed with ${JSON.stringify(response)}`);
            throw new Error('rtpengine failed: answer');
          }
          res.send(200);
        }
      }
      else if (dlg.type === 'uas' && ['application/dtmf-relay', 'application/dtmf'].includes(contentType)) {
        const arr = /Signal=\s*([0-9#*])/.exec(req.body);
        if (!arr) {
          this.logger.info({body: req.body}, '_onInfo: invalid INFO dtmf request');
          throw new Error(`_onInfo: no dtmf in body for ${contentType}`);
        }
        const code = arr[1];
        const arr2 = /Duration=\s*(\d+)/.exec(req.body);
        const duration = arr2 ? arr2[1] : 250;

        if (this.isMediaReleased) {
          /* just relay on to the feature server */
          this.logger.info({code, duration}, 'got SIP INFO DTMF from caller, relaying to feature server');
          this._onDTMF(dlg.other, {event: code, duration})
            .catch((err) => this.logger.info({err}, 'Error relaying DTMF to feature server'));
          res.send(200);
        }
        else {
          /* else convert SIP INFO to RFC 2833 telephony events */
          this.logger.info({code, duration}, 'got SIP INFO DTMF from caller, converting to RFC 2833');
          const opts = {
            ...this.rtpEngineOpts.common,
            'from-tag': this.rtpEngineOpts.uas.tag,
            code,
            duration
          };
          const response = await this.playDTMF(opts);
          if ('ok' !== response.result) {
            this.logger.info({response}, `rtpengine playDTMF failed with ${JSON.stringify(response)}`);
            throw new Error('rtpengine failed: answer');
          }
          res.send(200);
        }
      }
      else {
        const headers = {};
        Object.keys(req.headers).forEach((h) => {
          if (!IMMUTABLE_HEADERS.includes(h)) headers[h] = req.headers[h];
        });
        const response = await dlg.other.request({method: 'INFO', headers, body: req.body});
        const responseHeaders = {};
        if (response.has('Content-Type')) {
          Object.assign(responseHeaders, {'Content-Type': response.get('Content-Type')});
        }
        res.send(response.status, {headers: responseHeaders, body: response.body});
      }
    } catch (err) {
      if (this.srsClients.length) {
        this.srsClients = [];
      }
      res.send(500);
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
        if (!req.has('Referred-By')) return res.send(400);
        const leaveReferToAlone = req.has('X-Refer-To-Leave-Untouched');
        if (leaveReferToAlone) {
          this.logger.debug({referTo}, 'passing Refer-To header through untouched');
        }
        else {
          const isDotDecimal = /^(?:[0-9]{1,3}\.){3}[0-9]{1,3}$/.test(uri.host);
          let selectedGateway = false;
          let e164 = false;
          if (gateway && isDotDecimal) {
            /* host of Refer-to to an outbound gateway */
            const gw = await this.srf.locals.getOutboundGatewayForRefer(gateway.voip_carrier_sid);
            if (gw) {
              selectedGateway = true;
              e164 = gw.e164_leading_plus;
              uri.host = gw.ipv4;
              uri.port = gw.port;
            }
          }
          if (!selectedGateway && isDotDecimal) {
            uri.host = this.req.source_address;
            uri.port = this.req.source_port;
          }
          if (e164 && !uri.user.startsWith('+')) {
            uri.user = `+${uri.user}`;
          }
        }
        // eslint-disable-next-line no-unused-vars
        const {via, from, to, 'call-id':callid, cseq, 'max-forwards':maxforwards,
          // eslint-disable-next-line no-unused-vars
          'content-length':contentlength, 'refer-to':_referto, 'referred-by': referredby,
          // eslint-disable-next-line no-unused-vars
          'X-Refer-To-Leave-Untouched': _leave, contact: _contact,
          ...customHeaders
        } = req.headers;

        const response = await this.uas.request({
          method: 'REFER',
          headers: {
            'Refer-To': `<${stringifyUri(uri)}>`,
            'Referred-By': referredby,
            'Contact': this.contactHeader,
            ...customHeaders
          }
        });
        return res.send(response.status);
      }
      res.send(202);

      // invite to new fs
      const headers = {
        ...(req.has('X-Retain-Call-Sid') && {'X-Retain-Call-Sid': req.get('X-Retain-Call-Sid')}),
        ...(req.has('X-Account-Sid') && {'X-Account-Sid': req.get('X-Account-Sid')})
      };
      const uac = await this.srf.createUAC(referTo.uri, {localSdp: dlg.local.sdp, headers});
      this.uac = uac;
      uac.other = this.uas;
      this.uas.other = uac;
      uac.on('info', this._onInfo.bind(this, uac));
      uac.on('modify', this._onReinvite.bind(this, uac));
      uac.on('refer', this._onFeatureServerTransfer.bind(this, uac));
      uac.on('destroy', () => {
        this.logger.info('call ended with normal termination');
        this.rtpEngineResource.destroy();
        this.activeCallIds.delete(this.req.get('Call-ID'));
        uac.other.destroy();
        this.srf.endSession(this.req);
      });

      const opts = {
        ...this.rtpEngineOpts.common,
        'from-tag': this.rtpEngineOpts.uas.tag,
        'to-tag': this.rtpEngineOpts.uac.tag,
        sdp: uac.remote.sdp,
        flags: ['port latching']
      };
      const response = await this.answer(opts);
      if ('ok' !== response.result) {
        throw new Error(`_onFeatureServerTransfer: rtpengine answer failed: ${JSON.stringify(response)}`);
      }
      dlg.destroy().catch(() => {});
      this.logger.info('successfully moved call to new feature server');
    } catch (err) {
      res.send(488);
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
        this.unsubscribeForDTMF();
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
      /* REFER coming in from a sip device, forward to feature server */
      try {
        const response = await dlg.other.request({
          method: 'REFER',
          headers: {
            'Refer-To': req.get('Refer-To'),
            'Referred-By': req.get('Referred-By'),
            'User-Agent': req.get('User-Agent')
          }
        });
        res.send(response.status, response.reason);
      } catch (err) {
        this.logger.error({err}, 'CallSession:_onRefer: error handling incoming REFER');
      }
    }
  }

}

module.exports = CallSession;
