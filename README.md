### good-google-cloud

```js
'use strict';

const Hapi = require('hapi');
const server = new Hapi.Server();
server.connection({ uri: 'http://mysite.com' }); // logs will respect server.info.uri, set it here if you want them to be pretty

server.register([{
    register: require('good-google-cloud') // setup some event listeners that gather extra context
}, {
    register: require('good'),
    options: {
        reporters: {
            google: [{
                module: 'good-squeeze',
                name: 'Squeeze',
                args: [{ request: '*', response: '*', log: '*', error: '*' }]
            }, {
                module: 'good-google-cloud',
                name: 'Logger',
                args: [{ name: 'my-app' }] // "name" will be used as your log name, as well as the operation producer
                // you must either export GCLOUD_PROJECT in your environment or pass a "project_id" property if you want your logs
                // to go to the "Global" resource, you can also pass a "resource" object here to define where your logs will go more specifically
            }]
        }
    }
}], (err) => {

    if (err) {
        throw err;
    }

    server.start(() => {

        server.log(['info'], 'my-app started');
    });
});
```
