'use strict';
// Creates the company provisioning key (src/main/config/provisioning.key).
// Run once:  npm run make-key      (add --force to replace an existing key)
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const file = path.join(__dirname, '..', 'src', 'main', 'config', 'provisioning.key');
if (fs.existsSync(file) && !process.argv.includes('--force')) {
  console.log('A key already exists:', file);
  console.log('Keep using it. (Use --force only if you really want a new one; old settings files will stop working.)');
  process.exit(0);
}
const key = crypto.randomBytes(48).toString('base64');
fs.writeFileSync(file, key + '\n');
console.log('Created', file);
console.log('\nNext steps:');
console.log(' 1. Keep a backup of this file somewhere safe (e.g. your password manager).');
console.log(' 2. On GitHub: Settings > Secrets and variables > Actions > New repository secret');
console.log('    Name:  CB_PROVISIONING_KEY');
console.log('    Value: ' + key);
