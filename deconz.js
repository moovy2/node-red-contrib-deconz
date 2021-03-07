const NODE_PATH = '/deconz/';
const path = require('path');

module.exports = function (RED) {
    /**
     * Enable http route to static files
     */
    RED.httpAdmin.get(NODE_PATH + 'static/*', function (req, res) {
        let options = {
            root: __dirname + '/static/',
            dotfiles: 'deny'
        };
        res.sendFile(req.params[0], options);
    });

    /**
     * Enable http route to multiple-select static files
     */
    RED.httpAdmin.get(NODE_PATH + 'multiple-select/*', function (req, res) {
        let options = {
            root: path.dirname(require.resolve('multiple-select')),
            dotfiles: 'deny'
        };
        res.sendFile(req.params[0], options);
    });

    /**
     * Enable http route to JSON itemlist for each controller (controller id passed as GET query parameter)
     */
    RED.httpAdmin.get(NODE_PATH + 'itemlist', function (req, res) {
        let config = req.query;
        let controller = RED.nodes.getNode(config.controllerID);
        let forceRefresh = config.forceRefresh ? ['1', 'yes', 'true'].includes(config.forceRefresh.toLowerCase()) : false;
        let query;
        let queryType = req.query.queryType || 'json';

        try {
            if (req.query.query !== undefined && ['json', 'jsonata'].includes(queryType)) {
                query = RED.util.evaluateNodeProperty(
                    req.query.query,
                    queryType,
                    RED.nodes.getNode(req.query.nodeID),
                    {}, undefined
                )
            }
        } catch (e) {
            // TODO display error to the user
        }

        if (controller && controller.constructor.name === "ServerNode") {
            controller.getItemsList(function (items) {
                if (items) {
                    res.json({items: items});
                } else {
                    res.status(404).end();
                }
            }, query, forceRefresh);
        } else {
            res.status(404).end();
        }
    });

    ['state', 'config'].forEach(function (type) {
        RED.httpAdmin.get(NODE_PATH + type + 'list', function (req, res) {
            let config = req.query;
            let controller = RED.nodes.getNode(config.controllerID);
            let devicesIDs = JSON.parse(config.devices);
            if (controller && controller.constructor.name === "ServerNode" && devicesIDs) {
                let sample = {};
                let count = {};
                devicesIDs.forEach(function (deviceID) {
                    let result = controller.getDeviceByPath(deviceID)
                    if (result && result[type]) {
                        Object.keys(result[type]).forEach(function (item) {
                            count[item] = (count[item] || 0) + 1
                            sample[item] = result[type][item]
                        });
                    }
                })
                res.json({count: count, sample: sample});
            } else {
                res.status(404).end();
            }
        });
    })

    RED.httpAdmin.get(NODE_PATH + 'getScenesByDevice', function (req, res) {
        let config = req.query;
        let controller = RED.nodes.getNode(config.controllerID);
        if (controller && controller.constructor.name === "ServerNode") {
            if ("scenes" in controller.items[config.device] && config.device in controller.items) {
                res.json(controller.items[config.device].scenes);
            } else {
                res.json({});
            }
        } else {
            res.status(404).end();
        }
    });
    // RED.httpAdmin.get(NODE_PATH + 'gwscanner', function (req, res) {
    //     // let ip = require("ip");
    //     // console.log ( ip.address() );
    //
    //     let portscanner = require('portscanner');
    //
    //     // 127.0.0.1 is the default hostname; not required to provide
    //     portscanner.findAPortNotInUse([80], '127.0.0.1').then(port => {
    //         console.log(`Port ${port} is available!`);
    //
    //         // Now start your service on this port...
    //     });
    // });
}
