// Opt-in feed at BUILD time. Never embed credentials or a private repository token.
const config = require('./package.json').build;
if (process.env.BUNVELOPE_UPDATE_URL) {
  const url = new URL(process.env.BUNVELOPE_UPDATE_URL);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    throw new Error('BUNVELOPE_UPDATE_URL must be a public HTTPS directory URL without credentials, query or fragment');
  }
  config.publish = [{ provider: 'generic', url: url.href }];
  // A build promising updates must be signed. Developer/test builds omit the feed.
  config.forceCodeSigning = true;
  if (process.platform === 'win32') {
    if (!process.env.BUNVELOPE_WINDOWS_PUBLISHER) throw new Error('Set BUNVELOPE_WINDOWS_PUBLISHER to the signing certificate publisher');
    config.win.publisherName = process.env.BUNVELOPE_WINDOWS_PUBLISHER;
  }
}
module.exports = config;
