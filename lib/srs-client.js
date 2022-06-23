const Emitter = require('events');
const assert = require('assert');
const transform = require('sdp-transform');
const { v4: uuidv4 } = require('uuid');

const createMultipartSdp = (sdp, {
  originalInvite,
  srsRecordingId,
  callSid,
  accountSid,
  applicationSid,
  sipCallId,
  aorFrom,
  aorTo,
  callingNumber,
  calledNumber
}) => {
  const sessionId = uuidv4();
  const uuidStream1 = uuidv4();
  const uuidStream2 = uuidv4();
  const participant1 = uuidv4();
  const participant2 = uuidv4();
  const sipSessionId = originalInvite.get('Call-ID');
  const {originator = 'unknown', carrier = 'unknown'} = originalInvite.locals;

  const x = `--uniqueBoundary
Content-Disposition: session;handling=required
Content-Type: application/sdp

--sdp-placeholder--
--uniqueBoundary
Content-Disposition: recording-session
Content-Type: application/rs-metadata+xml

<?xml version="1.0" encoding="UTF-8"?>
<recording xmlns="urn:ietf:params:xml:ns:recording:1">
  <datamode>complete</datamode>
  <session session_id="${sessionId}">
    <sipSessionID>${sipSessionId}</sipSessionID>
  </session>
  <extensiondata xmlns:jb="http://jambonz.org/siprec">
    <jb:callsid>${callSid}</jb:callsid>
    <jb:accountsid>${accountSid}</jb:accountsid>
    <jb:applicationsid>${applicationSid}</jb:applicationsid>
    <jb:recordingid>${srsRecordingId}</jb:recordingid>
    <jb:originationsource>${originator}</jb:originationsource>
    <jb:carrier>${carrier}</jb:carrier>
  </extensiondata>
  <participant participant_id="${participant1}">
    <nameID aor="${aorFrom}">
      <name>${callingNumber}</name>
    </nameID>
  </participant>
  <participantsessionassoc participant_id="${participant1}" session_id="${sessionId}">
  </participantsessionassoc>
  <stream stream_id="${uuidStream1}" session_id="${sessionId}">
    <label>1</label>
  </stream>
  <participant participant_id="${participant2}">
    <nameID aor="${aorTo}">
      <name>${calledNumber}</name>
    </nameID>
  </participant>
  <participantsessionassoc participant_id="${participant2}" session_id="${sessionId}">
  </participantsessionassoc>
  <stream stream_id="${uuidStream2}" session_id="${sessionId}">
    <label>2</label>
  </stream>
  <participantstreamassoc participant_id="${participant1}">
    <send>${uuidStream1}</send>
    <recv>${uuidStream2}</recv>
  </participantstreamassoc>
  <participantstreamassoc participant_id="${participant2}">
    <send>${uuidStream2}</send>
    <recv>${uuidStream1}</recv>
  </participantstreamassoc>
</recording>`
    .replace(/\n/g, '\r\n')
    .replace('--sdp-placeholder--', sdp);

  return `${x}\r\n`;
};

class SrsClient extends Emitter {
  constructor(logger, opts) {
    super();
    const {
      srf,
      originalInvite,
      calledNumber,
      callingNumber,
      srsUrl,
      srsRecordingId,
      callSid,
      accountSid,
      applicationSid,
      srsDestUserName,
      rtpEngineOpts,
      //fromTag,
      toTag,
      aorFrom,
      aorTo,
      subscribeRequest,
      subscribeAnswer,
      del,
      blockMedia,
      unblockMedia,
      unsubscribe
    } = opts;
    this.logger = logger;
    this.srf = srf;
    this.originalInvite = originalInvite;
    this.callingNumber = callingNumber;
    this.calledNumber = calledNumber;
    this.subscribeRequest = subscribeRequest;
    this.subscribeAnswer = subscribeAnswer;
    this.del = del;
    this.blockMedia = blockMedia;
    this.unblockMedia = unblockMedia;
    this.unsubscribe = unsubscribe;
    this.srsUrl = srsUrl;
    this.srsRecordingId = srsRecordingId;
    this.callSid = callSid;
    this.accountSid = accountSid;
    this.applicationSid = applicationSid;
    this.srsDestUserName = srsDestUserName;
    this.rtpEngineOpts = rtpEngineOpts;
    this.sipRecFromTag = toTag;
    this.aorFrom = aorFrom;
    this.aorTo = aorTo;

    /* state */
    this.activated = false;
    this.paused = false;
  }

  async start() {
    assert(!this.activated);

    const opts = {
      'call-id': this.rtpEngineOpts.common['call-id'],
      'from-tag': this.sipRecFromTag
    };

    let response = await this.subscribeRequest({...opts, label: '1', flags: ['all'], interface: 'public'});
    if (response.result !== 'ok') {
      this.logger.error({response}, 'SrsClient:start error calling subscribe request');
      throw new Error('error calling subscribe request');
    }
    this.siprecToTag = response['to-tag'];

    const parsed = transform.parse(response.sdp);
    parsed.name = 'jambonz SRS';
    parsed.media[0].label = '1';
    parsed.media[1].label = '2';
    this.sdpOffer = transform.write(parsed);
    const sdp = createMultipartSdp(this.sdpOffer, {
      originalInvite: this.originalInvite,
      srsRecordingId: this.srsRecordingId,
      callSid: this.callSid,
      accountSid: this.accountSid,
      applicationSid: this.applicationSid,
      calledNumber: this.calledNumber,
      callingNumber: this.callingNumber,
      aorFrom: this.aorFrom,
      aorTo: this.aorTo
    });

    this.logger.info({response}, `SrsClient: sending SDP ${sdp}`);

    /* */
    try {
      this.uac = await this.srf.createUAC(this.srsUrl, {
        headers: {
          'Content-Type': 'multipart/mixed;boundary=uniqueBoundary',
        },
        localSdp: sdp
      });
    } catch (err) {
      this.logger.info({err}, `Error sending SIPREC INVITE to ${this.srsUrl}`);
      throw err;
    }

    this.logger.info({sdp: this.uac.remote.sdp}, `SrsClient:start - successfully connected to SRS ${this.srsUrl}`);
    response = await this.subscribeAnswer({
      ...opts,
      sdp: this.uac.remote.sdp,
      'to-tag': response['to-tag'],
      label: '2'
    });
    if (response.result !== 'ok') {
      this.logger.error({response}, 'SrsClient:start error calling subscribe answer');
      throw new Error('error calling subscribe answer');
    }

    this.activated = true;
    this.logger.info('successfully established siprec connection');
    return true;
  }

  async stop() {
    assert(this.activated);
    const opts = {
      'call-id': this.rtpEngineOpts.common['call-id'],
      'from-tag': this.sipRecFromTag
    };

    this.del(opts)
      //.then((response) => this.logger.debug({response}, 'Successfully stopped siprec media'))
      .catch((err) => this.logger.info({err}, 'Error deleting siprec media session'));
    this.uac.destroy().catch(() => {});
    this.activated = false;
    return true;
  }

  async pause() {
    assert(!this.paused);
    const opts = {
      'call-id': this.rtpEngineOpts.common['call-id'],
      'from-tag': this.sipRecFromTag
    };
    try {
      await this.blockMedia(opts);
      await this.uac.modify(this.sdpOffer.replace(/sendonly/g, 'inactive'));
      this.paused = true;
      return true;
    } catch (err) {
      this.logger.info({err}, 'Error pausing siprec media session');
    }
    return false;
  }

  async resume() {
    assert(this.paused);
    const opts = {
      'call-id': this.rtpEngineOpts.common['call-id'],
      'from-tag': this.sipRecFromTag
    };
    try {
      await this.blockMedia(opts);
      await this.uac.modify(this.sdpOffer);
    } catch (err) {
      this.logger.info({err}, 'Error resuming siprec media session');
    }
    return true;
  }
}

module.exports = SrsClient;
