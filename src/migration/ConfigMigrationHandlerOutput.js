const ConfigMigrationHandler = require('./ConfigMigrationHandler');
const Utils = require("../runtime/Utils");

class ConfigMigrationHandlerOutput extends ConfigMigrationHandler {
    get lastVersion() {
        return 1; // Don't forget to update node declaration too
    }

    migrate(controller) {
        this.controller = controller;
        if (this.currentVersion === undefined) this.migrateFromLegacy();
        this.result.new.config_version = this.config_version;
    }

    migrateFromLegacy() {
        // Migrate device
        let device = super.migrateDeviceFromLegacy();

        let command = {
            arg: {}
        };

        // TODO Migrate commands
        switch (this.config.commandType) {
            case 'deconz_cmd':
                command.type = 'deconz_state';
                if (this.config.device.substr(0, 6) === 'group_') {
                    command.domain = 'groups';
                } else if (Utils.isDeviceCover(device)) {
                    command.domain = 'covers';
                } else {
                    command.domain = 'lights';
                }
                command.target = 'state';
                switch (this.config.command) {
                    case 'on':
                        switch (this.config.payloadType) {
                            case 'deconz_payload':
                                command.arg.on = {
                                    type: 'set',
                                    value: (this.config.payload === '1').toString()
                                };
                                break;
                            case 'msg':
                            case 'flow':
                            case 'global':
                                command.arg.on = {
                                    type: this.config.payloadType,
                                    value: this.config.payload
                                };
                                break;
                            case 'str':
                                if (this.config.payload === 'true') {
                                    command.arg.on = {
                                        type: 'turn',
                                        value: true
                                    };
                                } else if (this.config.payload === 'false') {
                                    command.arg.on = {
                                        type: 'turn',
                                        value: false
                                    };
                                } else {
                                    this.result.errors.push(`Invalid value '${this.config.payload}' for option Switch (true/false)`);
                                }
                                break;
                            case 'num':
                                if (this.config.payload === '1') {
                                    command.arg.on = {
                                        type: 'turn',
                                        value: true
                                    };
                                } else if (this.config.payload === '0') {
                                    command.arg.on = {
                                        type: 'turn',
                                        value: false
                                    };
                                } else {
                                    this.result.errors.push(`Invalid value '${this.config.payload}' for option Switch (true/false)`);
                                }
                                break;
                            default:
                                this.result.errors.push(`Invalid value type '${this.config.payloadType}' for option Switch (true/false)`);
                                break;
                        }
                        break;

                    case 'toggle':
                        command.arg.on = {
                            type: 'toggle'
                        };
                        break;

                    case 'bri':
                    case 'hue':
                    case 'sat':
                        command.arg[this.config.command] = {
                            direction: 'set'
                        };
                        switch (this.config.payloadType) {
                            case 'msg':
                            case 'flow':
                            case 'global':
                                command.arg[this.config.command].type = this.config.payloadType;
                                command.arg[this.config.command].value = this.config.payload;
                                break;
                            case 'str':
                            case 'num':
                                command.arg[this.config.command].type = 'num';
                                if (isNaN(this.config.payload)) {
                                    this.result.errors.push(`Invalid value '${this.config.payload}' for option '${this.config.command}'`);
                                } else {
                                    command.arg[this.config.command].value = parseInt(this.config.payload);
                                }
                                break;
                            default:
                                this.result.errors.push(`Invalid value type '${this.config.payloadType}' for option '${this.config.command}'`);
                                break;
                        }
                        break;
                    case 'ct':
                        command.arg.ct = {
                            direction: 'set'
                        };
                        switch (this.config.payloadType) {
                            case 'deconz_payload':
                                command.arg.ct.type = 'deconz';
                                switch (this.config.payload) {
                                    case '153':
                                        command.arg.ct.value = 'cold';
                                        break;
                                    case '320':
                                        command.arg.ct.value = 'white';
                                        break;
                                    case '500':
                                        command.arg.ct.value = 'warm';
                                        break;
                                    default:
                                        if (isNaN(this.config.payload)) {
                                            this.result.errors.push(`Invalid value '${this.config.payload}' for option 'ct'`);
                                        } else {
                                            command.arg.ct.type = 'num';
                                            command.arg.ct.value = parseInt(this.config.payload);
                                        }
                                        break;
                                }
                                break;
                            case 'msg':
                            case 'flow':
                            case 'global':
                                command.arg.ct.type = this.config.payloadType;
                                command.arg.ct.value = this.config.payload;
                                break;
                            case 'str':
                            case 'num':
                                command.arg.ct.type = 'num';
                                if (isNaN(this.config.payload)) {
                                    this.result.errors.push(`Invalid value '${this.config.payload}' for option 'ct'`);
                                } else {
                                    command.arg.ct.value = parseInt(this.config.payload);
                                }
                                break;
                            default:
                                this.result.errors.push(`Invalid value type '${this.config.payloadType}' for option 'ct'`);
                                break;
                        }
                        break;
                    case 'xy':
                        switch (this.config.payloadType) {
                            case 'msg':
                            case 'flow':
                            case 'global':
                                command.arg.xy.type = this.config.payloadType;
                                command.arg.xy.value = this.config.payload;
                                break;
                            default:
                                this.result.errors.push(`Invalid value type '${this.config.payloadType}' for option 'xy'`);
                                break;
                        }
                        break;

                    case 'scene':
                        command.domain = 'scene_call';

                        // Strip 'group_' from device name
                        let part = this.config.device.substring(6);
                        if (part.length === 0 || isNaN(part)) {
                            this.result.errors.push(`Invalid group ID '${this.config.device}' for calling scene`);
                        } else {
                            command.arg.group = {
                                type: 'num',
                                value: parseInt(part)
                            };
                        }

                        switch (this.config.payloadType) {
                            case 'deconz_payload':
                            case 'str':
                            case 'num':
                                if (isNaN(this.config.payload)) {
                                    this.result.errors.push(`Invalid scene ID '${this.config.payload}' for calling scene`);
                                } else {
                                    command.arg.scene = {
                                        type: 'num',
                                        value: parseInt(this.config.payload)
                                    };
                                }
                                break;
                            case 'msg':
                            case 'flow':
                            case 'global':
                                command.arg.scene = {
                                    type: this.config.payloadType,
                                    value: this.config.payload
                                };
                                break;
                            default:
                                this.result.errors.push(`Invalid value type '${this.config.payloadType}' for calling scene`);
                                break;
                        }
                        break;

                    case 'alert':
                        command.arg.alert = {};
                        switch (this.config.payloadType) {
                            case 'deconz_payload':
                                switch (this.config.payload) {
                                    case 'none':
                                    case 'select':
                                    case 'lselect':
                                        command.arg.alert.type = this.config.payload;
                                        break;
                                    default:
                                        this.result.errors.push(`Invalid value type '${this.config.payloadType}' for option 'alert'`);
                                        break;
                                }
                                break;
                            case 'msg':
                            case 'flow':
                            case 'global':
                                command.arg.alert.type = this.config.payloadType;
                                command.arg.alert.value = this.config.payload;
                                break;
                            case 'str':
                            case 'num':
                                command.arg.alert.type = 'str';
                                command.arg.alert.value = this.config.payload.toString();
                                break;
                            default:
                                this.result.errors.push(`Invalid value type '${this.config.payloadType}' for option 'alert'`);
                                break;
                        }
                        break;

                    case 'effect':
                        switch (this.config.payloadType) {
                            case 'deconz_payload':
                                switch (this.config.payload) {
                                    case 'none':
                                    case 'colorloop':
                                        command.arg.effect.type = this.config.payload;
                                        break;
                                    default:
                                        this.result.errors.push(`Invalid value type '${this.config.payloadType}' for option 'effect'`);
                                        break;
                                }
                                break;
                            case 'msg':
                            case 'flow':
                            case 'global':
                                command.arg.effect.type = this.config.payloadType;
                                command.arg.effect.value = this.config.payload;
                                break;
                            case 'str':
                            case 'num':
                                command.arg.effect.type = 'str';
                                command.arg.effect.value = this.config.payload.toString();
                                break;
                            default:
                                this.result.errors.push(`Invalid value type '${this.config.payloadType}' for option 'effect'`);
                                break;
                        }
                        break;

                    case 'colorloopspeed':
                        switch (this.config.payloadType) {
                            case 'msg':
                            case 'flow':
                            case 'global':
                                command.arg.ct.type = this.config.payloadType;
                                command.arg.ct.value = this.config.payload;
                                break;
                            case 'str':
                            case 'num':
                                command.arg.ct.type = 'num';
                                if (isNaN(this.config.payload)) {
                                    this.result.errors.push(`Invalid value '${this.config.payload}' for option 'ct'`);
                                } else {
                                    command.arg.ct.value = parseInt(this.config.payload);
                                }
                                break;
                            default:
                                this.result.errors.push(`Invalid value type '${this.config.payloadType}' for option 'ct'`);
                                break;
                        }
                        break;
                }

                if (this.config.command !== 'on')
                    command.arg.on = {type: 'set', value: 'true'};
                if (this.config.command === 'bri' && !isNaN(this.config.payload))
                    command.arg.on = {type: 'set', value: Number(this.config.payload) > 0 ? 'true' : 'false'};
                break;

            case 'homekit':
                command.type = 'homekit';
                switch (this.config.payloadType) {
                    case 'msg':
                        command.arg.payload = {
                            type: this.config.payloadType,
                            value: this.config.payload
                        };
                        break;
                    case 'flow':
                    case 'global':
                    case 'str':
                    case 'num':
                        command.errors.push(`The type '${this.config.payloadType}' was not valid in legacy version, he has been converted to 'msg'.`);
                        command.arg.payload = {
                            type: 'msg',
                            value: this.config.payload
                        };
                        break;
                    default:
                        this.result.errors.push(`Invalid value type '${this.config.payloadType}' for option Switch (true/false)`);
                        break;
                }
                break;

            case 'str':
                command.type = 'custom';
                command.arg.target = 'state';
                command.arg.command = {
                    type: 'str',
                    value: this.config.command
                };
                command.arg.payload = {
                    type: this.config.payloadType,
                    value: this.config.payload
                };
                break;
            case 'msg':
                command.type = 'custom';
                command.arg.target = 'state';
                command.arg.command = {
                    type: 'msg',
                    value: this.config.command
                };
                command.arg.payload = {
                    type: this.config.payloadType,
                    value: this.config.payload
                };
                break;
            case 'object':
                command.type = 'custom';
                command.arg.target = 'state';
                command.arg.command = {type: 'object'};
                command.arg.payload = {
                    type: this.config.payloadType,
                    value: this.config.payload
                };
                break;
            default:
                throw new Error('Invalid command type for migration');
        }


        switch (this.config.transitionTimeType) {
            case 'msg':
            case 'flow':
            case 'global':
                command.arg.transition = {
                    type: this.config.transitionTimeType,
                    value: this.config.transitionTime
                };
                break;
            case 'str':
            case 'num':
                command.arg.transition = {type: 'num'};
                if (isNaN(this.config.transitionTime)) {
                    this.result.errors.push(`Invalid value '${this.config.transitionTime}' for option 'transition'`);
                } else {
                    command.arg.transition.value = parseInt(this.config.transitionTime);
                }
                break;
            default:
                if (typeof this.config.transitionTimeType === 'undefined') {
                    command.arg.transition = {type: 'num'};
                } else {
                    this.result.errors.push(`Invalid value type '${this.config.transitionTimeType}' for option 'transition'`);
                }
                break;
        }

        this.result.delete.push('command');
        this.result.delete.push('commandType');
        this.result.delete.push('payload');
        this.result.delete.push('payloadType');
        this.result.delete.push('transitionTime');
        this.result.delete.push('transitionTimeType');

        command.arg.aftererror = 'continue';
        this.result.new.commands = [command];
        this.result.new.specific = {
            delay: 50,
            result: 'never'
        };
        this.config_version = 1;
    }

}

module.exports = ConfigMigrationHandlerOutput;
