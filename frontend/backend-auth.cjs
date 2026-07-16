const readline = require('node:readline');

const AUTH_TOKEN_LINE = /^CS2_INSIGHT_AUTH_TOKEN=([A-Za-z0-9_-]+)$/;


function attachBackendOutput(stdout, { onToken, onLog }) {
  const reader = readline.createInterface({
    input: stdout,
    crlfDelay: Infinity,
  });

  reader.on('line', (line) => {
    const tokenMatch = line.match(AUTH_TOKEN_LINE);
    if (tokenMatch) {
      onToken(tokenMatch[1]);
      return;
    }
    onLog(line);
  });

  return reader;
}


module.exports = { attachBackendOutput };
