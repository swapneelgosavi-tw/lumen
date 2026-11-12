const sm = require('service-metadata');
const urlopen = require('urlopen');
const uri = sm.getVar('var://service/URI');
const method = sm.getVar('var://service/protocol-method');
const BASE = 'https://api.partner.example.com';
const routes = { '/payments': 'https://pay.example.com/v2', '/kyc': 'https://kyc.example.com' };
let target;
if (uri.startsWith('/orders')) {
  target = BASE + '/orders-api' + uri;
} else if (method === 'POST' && uri.indexOf('/ship') === 0) {
  target = `https://ship.example.com/api${uri}`;
}
if (target) sm.setVar('var://service/routing-url', target);
const p = Object.keys(routes).find(k => uri.startsWith(k));
sm.setVar('var://service/routing-url', routes[p] + uri);
urlopen.open({ target: 'https://audit.example.com/log', method: 'POST' }, function(e, r){});
switch (uri) { case '/legacy': sm.setVar('var://service/routing-url', 'http://legacy.internal:8080/x'); break; }
