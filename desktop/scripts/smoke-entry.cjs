// Test-only launcher, excluded from packaged application files.
const { app } = require('electron');
app.setPath('appData', process.env.BUNVELOPE_SMOKE_PROFILE);
require('../main/index.cjs');
