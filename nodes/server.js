const got = require('got');

const dotProp = require('dot-prop');
const DeviceList = require('../src/runtime/DeviceList');
const DeconzAPI = require("../src/runtime/DeconzAPI");
const DeconzSocket = require("../src/runtime/DeconzSocket");
const ConfigMigration = require("../src/migration/ConfigMigration");
const Query = require('../src/runtime/Query');
const Utils = require("../src/runtime/Utils");

module.exports = function (RED) {
    class ServerNode {
        constructor(config) {
            RED.nodes.createNode(this, config);
            let node = this;
            node.config = config;
            node.state = {
                ready: false,
                pooling: {
                    isValid: false,
                    reachable: false,
                    discoverProcessRunning: false,
                    lastPooling: undefined,
                    failCount: 0,
                    errorTriggered: false
                },
                websocket: {
                    isValid: false,
                    reachable: false,
                    lastConnected: undefined,
                    lastEvent: undefined,
                    lastDisconnected: undefined,
                    eventCount: 0
                }
            };

            // Config migration
            let configMigration = new ConfigMigration('deconz-server', node.config, this);
            let migrationResult = configMigration.applyMigration(node.config, node);
            if (Array.isArray(migrationResult.errors) && migrationResult.errors.length > 0) {
                migrationResult.errors.forEach(
                    error => node.error(`Error with migration of node ${node.type} with id ${node.id}`, error)
                );
            }

            node.device_list = new DeviceList();
            node.api = new DeconzAPI({
                ip: node.config.ip,
                port: node.config.port,
                apikey: node.credentials.secured_apikey
            });

            // Example : ["ea9cd132.08f36"]
            node.nodesWithQuery = [];
            node.nodesEvent = [];
            node.nodesByDevicePath = {};

            node.setMaxListeners(255);
            node.refreshDiscoverTimer = null;
            node.refreshDiscoverInterval = node.config.polling >= 3 ? node.config.polling * 1000 : 15000;

            node.on('close', () => this.onClose());

            (async () => {
                try {
                    //TODO make the delay configurable
                    await Utils.sleep(1500);

                    let pooling = async () => {
                        let result = await node.discoverDevices({forceRefresh: true});
                        if (result === true) {
                            if (node.state.pooling.isValid === false) {
                                node.state.pooling.isValid = true;
                                node.state.ready = true;
                                this.setupDeconzSocket(node);
                                node.emit('onStart');
                            }
                            node.state.pooling.reachable = true;
                            node.state.pooling.lastPooling = Date.now();
                            node.state.pooling.failCount = 0;
                            if (node.state.pooling.errorTriggered === true) {
                                node.log(`discoverDevices: Connected to deconz API.`);
                            }
                            node.state.pooling.errorTriggered = false;
                        } else if (node.state.pooling.isValid === false) {
                            node.state.pooling.failCount++;
                            let code = RED._('node-red-contrib-deconz/server:status.deconz_not_reachable');
                            let reason = "discoverDevices: Can't connect to deconz API since starting. " +
                                "Please check server configuration.";
                            if (node.state.pooling.errorTriggered === false) {
                                node.state.pooling.errorTriggered = true;
                                node.propagateErrorNews(code, reason, true);
                            }
                            if (node.state.pooling.failCount % 4 === 1) {
                                node.error(reason);
                            }
                        } else {
                            node.state.pooling.failCount++;
                            let code = RED._('node-red-contrib-deconz/server:status.deconz_not_reachable');
                            let reason = "discoverDevices: Can't connect to deconz API.";

                            if (node.state.pooling.errorTriggered === false) {
                                node.state.pooling.errorTriggered = true;
                                node.propagateErrorNews(code, reason, true);
                            }
                            if (node.state.pooling.failCount % 4 === 1) {
                                node.error(reason);
                            }
                        }
                    };

                    await pooling();
                    this.refreshDiscoverTimer = setInterval(pooling, node.refreshDiscoverInterval);

                } catch (e) {
                    node.state.ready = false;
                    node.error("Deconz Server node error " + e.toString());
                }
            })();
        }

        async waitForReady(maxDelay = 10000) {
            const pauseDelay = 100;
            let pauseCount = 0;
            while (this.ready === false) {
                await Utils.sleep(pauseDelay);
                pauseCount++;
                if (pauseCount * pauseDelay >= maxDelay) {
                    break;
                }
            }
        }

        setupDeconzSocket(node) {
            node.socket = new DeconzSocket({
                hostname: node.config.ip,
                port: node.config.ws_port,
                secure: node.config.secure || false
            });
            node.socket.on('open', () => {
                node.log(`WebSocket opened`);
                node.state.websocket.isValid = true;
                node.state.websocket.reachable = true;
                node.state.websocket.lastConnected = Date.now();
                // This is used only on websocket reconnect, not the initial connection.
                if (node.state.ready) node.propagateStartNews();
            });
            node.socket.on('message', (payload) => this.onSocketMessage(payload));
            node.socket.on('error', (err) => {
                let node = this;
                node.state.websocket.reachable = false;
                node.state.websocket.lastDisconnected = Date.now();
                node.error(`WebSocket error: ${err}`);
            });
            node.socket.on('close', (code, reason) => {
                node.state.websocket.reachable = false;
                node.state.websocket.lastDisconnected = Date.now();
                if (reason) { // don't bother the user unless there's a reason
                    node.warn(`WebSocket disconnected: ${code} - ${reason}`);
                }
                if (node.state.ready) node.propagateErrorNews(code, reason);
            });
            node.socket.on('pong-timeout', () => {
                let node = this;
                node.state.websocket.reachable = false;
                node.state.websocket.lastDisconnected = Date.now();
                node.warn('WebSocket connection timeout, reconnecting');
            });
            node.socket.on('unauthorized', () => () => {
                let node = this;
                node.state.websocket.isValid = false;
                node.state.websocket.lastDisconnected = Date.now();
                node.warn('WebSocket authentication failed');
            });
        }

        async discoverDevices(opt) {
            let node = this;
            let options = Object.assign({
                forceRefresh: false,
                callback: () => {
                }
            }, opt);

            if (options.forceRefresh === false || node.state.pooling.discoverProcessRunning === true) {
                //node.log('discoverDevices: Using cached devices');
                return;
            }

            node.state.pooling.discoverProcessRunning = true;
            try {
                const response = await got(node.api.url.main(), {retry: 1, timeout: 2000}).json();
                node.device_list.parse(response);
                //node.log(`discoverDevices: Updated ${node.device_list.count}`);
                node.state.pooling.discoverProcessRunning = false;
                return true;
            } catch (e) {
                //node.error(`discoverDevices: Can't connect to deconz API.`);
                node.state.pooling.discoverProcessRunning = false;
                return false;
            }
        }

        propagateStartNews() {
            let node = this;
            // Node with device selected
            for (let [device_path, nodeIDs] of Object.entries(node.nodesByDevicePath)) {
                node.propagateNews(nodeIDs, {
                    type: 'start',
                    node_type: 'device_path',
                    device: node.device_list.getDeviceByPath(device_path)
                });
            }

            // Node with quety
            for (let nodeID of node.nodesWithQuery) {
                let target = RED.nodes.getNode(nodeID);

                if (!target) {
                    console.warn('ERROR: cant get ' + nodeID + ' node for start news, removed from list NodeWithQuery');
                    node.unregisterNodeWithQuery(nodeID);
                    continue;
                }

                // TODO Cache JSONata expresssions ?
                let querySrc = RED.util.evaluateJSONataExpression(
                    RED.util.prepareJSONataExpression(target.config.query, target),
                    {},
                    undefined
                );
                try {
                    let devices = node.device_list.getDevicesByQuery(querySrc);
                    if (devices.matched.length === 0) continue;
                    for (let device of devices.matched) {
                        node.propagateNews(nodeID, {
                            type: 'start',
                            node_type: 'query',
                            device: device,
                        });
                    }
                } catch (e) {
                    node.status({
                        fill: "red",
                        shape: "dot",
                        text: "node-red-contrib-deconz/server:status.query_error"
                    });
                    node.error(e.toString() + '\nNode ID : ' + nodeID + '\nQuery: ' + JSON.stringify(querySrc));
                }
            }
        }

        propagateErrorNews(code, reason, isGlobalError = false) {
            let node = this;
            if (!reason) return;

            // Node with device selected
            for (let [device_path, nodeIDs] of Object.entries(node.nodesByDevicePath)) {
                node.propagateNews(nodeIDs, {
                    type: 'error',
                    node_type: 'device_path',
                    device: node.device_list.getDeviceByPath(device_path),
                    errorCode: code,
                    errorMsg: `WebSocket disconnected: ${reason || 'no reason provided'}`,
                    isGlobalError
                });
            }

            // Node with quety
            for (let nodeID of node.nodesWithQuery) {
                let target = RED.nodes.getNode(nodeID);

                if (!target) {
                    console.warn('ERROR: cant get ' + nodeID + ' node for error news, removed from list NodeWithQuery');
                    node.unregisterNodeWithQuery(nodeID);
                    continue;
                }

                // TODO Cache JSONata expresssions ?
                let querySrc = RED.util.evaluateJSONataExpression(
                    RED.util.prepareJSONataExpression(target.config.query, target),
                    {},
                    undefined
                );
                try {
                    let devices = node.device_list.getDevicesByQuery(querySrc);
                    if (devices.matched.length === 0) continue;
                    for (let device of devices.matched) {
                        node.propagateNews(nodeID, {
                            type: 'error',
                            node_type: 'query',
                            device: device,
                            errorCode: code,
                            errorMsg: `WebSocket disconnected: ${reason || 'no reason provided'}`,
                            isGlobalError
                        });
                    }
                } catch (e) {
                    node.status({
                        fill: "red",
                        shape: "dot",
                        text: "node-red-contrib-deconz/server:status.query_error"
                    });
                    node.error(e.toString() + '\nNode ID : ' + nodeID + '\nQuery: ' + JSON.stringify(querySrc));
                }
            }
        }

        /**
         *
         * @param nodeIDs List of nodes [nodeID1, nodeID2]
         * @param news Object what kind of news need to be sent
         *     {type: 'start|event|error', eventData:{}, errorCode: "", errorMsg: "", device: {}, changed: {}}
         */
        propagateNews(nodeIDs, news) {
            //TODO add the event type in the msg
            let node = this;

            // Make sure that we have node to send the message to
            if (nodeIDs === undefined || Array.isArray(nodeIDs) && nodeIDs.length === 0) return;
            if (!Array.isArray(nodeIDs)) nodeIDs = [nodeIDs];

            for (const nodeID of nodeIDs) {
                let target = RED.nodes.getNode(nodeID);

                // Check if device exist
                if (news.device === undefined) {
                    target.handleDeconzEvent(
                        news.device,
                        [],
                        {},
                        {
                            errorEvent: true,
                            errorCode: "DEVICE_NOT_FOUND",
                            errorMsg: "Device not found, please check server configuration"
                        }
                    );
                    continue;
                }

                // If the target does not exist we remove it from the node list
                if (!target) {
                    switch (news.node_type) {
                        case 'device_path':
                            console.warn('ERROR: cant get ' + nodeID + ' node, removed from list nodesByDevicePath');
                            node.unregisterNodeByDevicePath(nodeID, news.device.device_path);
                            break;
                        case 'query':
                            console.warn('ERROR: cant get ' + nodeID + ' node, removed from list nodesWithQuery');
                            node.unregisterNodeWithQuery(nodeID);
                            break;
                        case 'event_node':
                            console.warn('ERROR: cant get ' + nodeID + ' node, removed from list nodesEvent');
                            node.unregisterEventNode(nodeID);
                            break;
                    }
                    return;
                }

                switch (news.type) {
                    case 'start':
                        switch (target.type) {
                            case 'deconz-input':
                            case 'deconz-battery':
                                target.handleDeconzEvent(
                                    news.device,
                                    [],
                                    news.device,
                                    {initialEvent: true}
                                );
                                break;
                        }

                        break;
                    case 'event':
                        let dataParsed = news.eventData;
                        switch (dataParsed.t) {
                            case "event":
                                if (target.type === "deconz-event") {
                                    target.handleDeconzEvent(
                                        news.device,
                                        news.changed,
                                        dataParsed
                                    );
                                    target.status({
                                        fill: "green",
                                        shape: "dot",
                                        text: RED._('node-red-contrib-deconz/server:status.event_count')
                                            .replace('{{event_count}}', node.state.websocket.eventCount)
                                    });
                                } else {
                                    switch (dataParsed.e) {
                                        case "added":
                                        case "deleted":
                                            node.discoverDevices({
                                                forceRefresh: true
                                            }).then();
                                            break;
                                        case "changed":
                                            if (['deconz-input', 'deconz-battery'].includes(target.type)) {
                                                target.handleDeconzEvent(
                                                    news.device,
                                                    news.changed,
                                                    dataParsed
                                                );
                                            } else {
                                                console.warn("WTF this is used : We tried to send a msg to a non input node.");
                                                continue;
                                            }
                                            break;
                                        case "scene-called":
                                            if (target.type === 'deconz-input') {
                                                target.handleDeconzEvent(
                                                    news.device,
                                                    news.changed,
                                                    dataParsed
                                                );
                                            }
                                            break;
                                        default:
                                            console.warn("Unknown event of type '" + dataParsed.e + "'. " + JSON.stringify(dataParsed));
                                            break;
                                    }
                                }
                                break;
                            default:
                                console.warn("Unknown message of type '" + dataParsed.t + "'. " + JSON.stringify(dataParsed));
                                break;
                        }

                        break;
                    case 'error':
                        switch (target.type) {
                            case 'deconz-input':
                            case 'deconz-battery':
                                target.handleDeconzEvent(
                                    news.device,
                                    [],
                                    {},
                                    {
                                        errorEvent: true,
                                        errorCode: news.errorCode || "Unknown Error",
                                        errorMsg: news.errorMsg || "Unknown Error"
                                    }
                                );
                                break;

                            //TODO Implement other node types
                        }
                        break;
                }

            }

        }

        registerEventNode(nodeID) {
            let node = this;
            if (!node.nodesEvent.includes(nodeID)) node.nodesEvent.push(nodeID);
        }

        unregisterEventNode(nodeID) {
            let node = this;
            let index = node.nodesEvent.indexOf(nodeID);
            if (index !== -1) node.nodesEvent.splice(index, 1);
        }

        registerNodeByDevicePath(nodeID, device_path) {
            let node = this;
            if (!(device_path in node.nodesByDevicePath)) node.nodesByDevicePath[device_path] = [];
            if (!node.nodesByDevicePath[device_path].includes(nodeID)) node.nodesByDevicePath[device_path].push(nodeID);
        }

        unregisterNodeByDevicePath(nodeID, device_path) {
            let node = this;
            let index = node.nodesByDevicePath[device_path].indexOf(nodeID);
            if (index !== -1) node.nodesByDevicePath[device_path].splice(index, 1);
        }

        registerNodeWithQuery(nodeID) {
            let node = this;
            if (!node.nodesWithQuery.includes(nodeID)) node.nodesWithQuery.push(nodeID);
        }

        unregisterNodeWithQuery(nodeID) {
            let node = this;
            let index = node.nodesWithQuery.indexOf(nodeID);
            if (index !== -1) node.nodesWithQuery.splice(index, 1);
        }

        onClose() {
            let node = this;
            clearInterval(node.refreshDiscoverTimer);
            node.state.ready = false;
            node.log('WebSocket connection closed');
            node.emit('onClose');
            node.socket.close();
            node.socket = undefined;
        }

        updateDevice(device, dataParsed) {
            let node = this;
            let changed = [];

            if (dotProp.has(dataParsed, 'name')) {
                device.name = dotProp.get(dataParsed, 'name');
                changed.push('name');
            }

            ['config', 'state'].forEach(function (key) {
                if (dotProp.has(dataParsed, key)) {
                    Object.keys(dotProp.get(dataParsed, key)).forEach(function (state_name) {
                        let valuePath = key + '.' + state_name;
                        let newValue = dotProp.get(dataParsed, valuePath);
                        let oldValue = dotProp.get(device, valuePath);
                        if (newValue !== oldValue) {
                            changed.push(`${key}.${state_name}`);
                            dotProp.set(device, valuePath, newValue);
                        }
                    });
                }
            });
            return changed;
        }

        onSocketMessage(dataParsed) {
            let node = this;
            node.state.websocket.lastEvent = Date.now();
            node.state.websocket.isValid = true;
            node.state.websocket.reachable = true;
            if (node.state.websocket.eventCount >= Number.MAX_SAFE_INTEGER) node.state.websocket.eventCount = 0;
            node.state.websocket.eventCount++;

            // Drop websocket msgs if the pooling don't work
            if (node.state.pooling.isValid === false) return console.error('Got websocket msg but the pooling is invalid. This should not happen.');

            node.emit('onSocketMessage', dataParsed); //Used by event node, TODO Really used ?

            let device;
            if (dataParsed.e === 'scene-called') {
                device = node.device_list.getDeviceByDomainID('groups', dataParsed.gid);
            } else {
                device = node.device_list.getDeviceByDomainID(dataParsed.r, dataParsed.id);
            }

            // TODO handle case if device is not found
            if (device === undefined) return console.error('Got websocket msg but the device does not exist. ' + JSON.stringify(dataParsed));
            let changed = node.updateDevice(device, dataParsed);

            // Node with device selected
            node.propagateNews(node.nodesByDevicePath[device.device_path], {
                type: 'event',
                node_type: 'device_path',
                eventData: dataParsed,
                device: device,
                changed: changed
            });

            // Node with quety
            let matched = [];
            for (let nodeID of node.nodesWithQuery) {
                let target = RED.nodes.getNode(nodeID);

                if (!target) {
                    console.warn('ERROR: cant get ' + nodeID + ' node for socket message news, removed from list NodeWithQuery');
                    node.unregisterNodeWithQuery(nodeID);
                    continue;
                }

                // TODO Cache JSONata expresssions ?
                let querySrc = RED.util.evaluateJSONataExpression(
                    RED.util.prepareJSONataExpression(target.config.query, target),
                    {},
                    undefined
                );
                try {
                    let query = new Query(querySrc);
                    if (query.match(device)) {
                        matched.push(nodeID);
                    }
                } catch (e) {
                    node.status({
                        fill: "red",
                        shape: "dot",
                        text: "node-red-contrib-deconz/server:status.query_error"
                    });
                    node.error(e.toString() + '\nNode ID : ' + nodeID + '\nQuery: ' + JSON.stringify(querySrc));
                }
            }

            if (matched.length > 0) node.propagateNews(matched, {
                type: 'event',
                node_type: 'query',
                eventData: dataParsed,
                device: device,
                changed: changed
            });

            // Event Nodes
            node.propagateNews(node.nodesEvent, {
                type: 'event',
                node_type: 'event_node',
                eventData: dataParsed,
                device: device,
                changed: changed
            });

        }

        getDefaultMsg(nodeType) {
            switch (nodeType) {
                case 'deconz-input':
                    return 'node-red-contrib-deconz/server:status.connected';
                case 'deconz-get':
                    return 'node-red-contrib-deconz/server:status.received';
                case 'deconz-output':
                    return 'node-red-contrib-deconz/server:status.done';
            }
        }

        updateNodeStatus(node, msgToSend) {
            if (node.server.ready === false) {
                node.status({
                    fill: "red",
                    shape: "dot",
                    text: "node-red-contrib-deconz/server:status.server_node_error"
                });
                return;
            }

            if (node.config.search_type === "device" && node.config.device_list.length === 0) {
                node.status({
                    fill: "red",
                    shape: "dot",
                    text: "node-red-contrib-deconz/server:status.device_not_set"
                });
                return;
            }

            if (msgToSend === null) {
                node.status({
                    fill: "green",
                    shape: "dot",
                    text: this.getDefaultMsg(node.type)
                });
                return;
            }

            let firstmsg = msgToSend[0];
            if (firstmsg === undefined) return;

            if (dotProp.get(firstmsg, 'meta.state.reachable') === false ||
                dotProp.get(firstmsg, 'meta.config.reachable') === false
            ) {
                node.status({
                    fill: "red",
                    shape: "ring",
                    text: "node-red-contrib-deconz/server:status.device_not_reachable"
                });
                return;
            }

            switch (node.config.statustext_type) {
                case 'msg':
                case 'jsonata':
                    node.status({
                        fill: "green",
                        shape: "dot",
                        text: Utils.getNodeProperty({
                            type: node.config.statustext_type,
                            value: node.config.statustext
                        }, node, firstmsg)
                    });
                    break;
                case 'auto':
                    switch (node.type) {
                        case 'deconz-input':
                        case 'deconz-get':
                            let firstOutputRule = node.config.output_rules[0];
                            if (firstOutputRule === undefined) return;
                            if (Array.isArray(firstOutputRule.payload) && firstOutputRule.payload.length === 1 &&
                                !['__complete__', '__each__'].includes(firstOutputRule.payload[0])
                            ) {
                                node.status({
                                    fill: "green",
                                    shape: "dot",
                                    text: firstmsg.payload
                                });
                            } else {
                                node.status({
                                    fill: "green",
                                    shape: "dot",
                                    text: this.getDefaultMsg(node.type)
                                });
                            }
                            break;
                        case 'deconz-battery':
                            let battery = dotProp.get(firstmsg, 'meta.config.battery');
                            if (battery === undefined) return;
                            node.status({
                                fill: (battery >= 20) ? ((battery >= 50) ? "green" : "yellow") : "red",
                                shape: "dot",
                                text: battery + '%'
                            });
                            break;
                    }
                    break;
            }
        }
    }

    RED.nodes.registerType('deconz-server', ServerNode, {
        credentials: {
            secured_apikey: {type: "text"}
        }
    });
};

