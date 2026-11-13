process.on('message', (message) => {
  if (message.t !== 'req') return;
  if (message.method === 'ping') {
    process.stdout.write('out-first\nout-second\nout-last');
    process.stderr.write('err-first\nerr-second\nerr-last');
    process.send({ t: 'res', id: message.id, ok: true, result: 'pong' });
  } else if (message.method === 'host.shutdown') {
    process.exit(0);
  }
});
process.send({ t: 'evt', channel: 'host.ready', payload: {} });
