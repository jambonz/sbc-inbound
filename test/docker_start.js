const test = require('tape').test ;
const exec = require('child_process').exec ;

test('starting docker network..', (t) => {
  exec(`docker-compose -f ${__dirname}/docker-compose-testbed.yaml up -d`, (err, stdout, stderr) => {
    t.pass('docker is up');
    t.end(err);
  });
  
});

  
