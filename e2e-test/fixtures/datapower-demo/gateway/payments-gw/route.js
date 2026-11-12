// IBM DataPower GatewayScript: routes calls received by the payments gateway to the final external API.
const sm = require('service-metadata');

const uri = sm.getVar('var://service/URI');

if (uri.startsWith('/payments/charge')) {
  sm.setVar('var://service/routing-url', 'https://bank.example.org/api/v2/charge');
} else if (uri.startsWith('/payments/refund')) {
  sm.setVar('var://service/routing-url', 'https://refunds.example.org/v1' + uri.substring('/payments'.length));
}
