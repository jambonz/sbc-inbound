const test = require('tape');
const { parseHostPorts } = require('../lib/utils');

process.on('unhandledRejection', (reason, p) => {
	console.log('Unhandled Rejection at: Promise', p, 'reason:', reason);
});

const hostports = "tls/3.70.141.74:5061,wss/3.70.141.74:8443,tcp/3.70.141.74:5060,udp/3.70.141.74:5060";
const hostportsNoTls = "wss/3.70.141.74:8443,tcp/3.70.141.74:5060,udp/3.70.141.74:5060";
const logger = { info: (args) => console.log(args) };

const srf = {
	locals: {
		sipAddress: '127.0.0.1'
	}
};

test('utils tests - parseHostPorts', async (t) => {
	try {
		let obj = parseHostPorts(logger, hostports, srf);

		const expected = {
			tls: '3.70.141.74:5061',
			wss: '3.70.141.74:8443',
			tcp: '3.70.141.74:5060',
			udp: '3.70.141.74:5060'
		};

		t.ok(obj.tls === expected.tls, 'sip endpoint tls');
		t.ok(obj.wss === expected.wss, 'sip endpoint wss');
		t.ok(obj.tcp === expected.tcp, 'sip endpoint tcp');
		t.ok(obj.udp === expected.udp, 'sip endpoint udp');

		obj = parseHostPorts(logger, hostportsNoTls.split(','), srf);

		t.ok(obj.tls === '127.0.0.1:5061', 'sip endpoint tls');

		t.end();
	} catch (err) {
		console.log(`error received: ${err}`);
		t.error(err);
	}
});
