(function() {
  function r(e, n, t) {
    function o(i, f) {
      if (!n[i]) {
        if (!e[i]) {
          var c = "function" == typeof require && require;
          if (!f && c) return c(i, !0);
          if (u) return u(i, !0);
          var a = new Error("Cannot find module '" + i + "'");
          throw ((a.code = "MODULE_NOT_FOUND"), a);
        }
        var p = (n[i] = { exports: {} });
        e[i][0].call(
          p.exports,
          function(r) {
            var n = e[i][1][r];
            return o(n || r);
          },
          p,
          p.exports,
          r,
          e,
          n,
          t
        );
      }
      return n[i].exports;
    }
    for (
      var u = "function" == typeof require && require, i = 0;
      i < t.length;
      i++
    )
      o(t[i]);
    return o;
  }
  return r;
})()(
  {
    1: [
      function(require, module, exports) {
        var Advertisement = require("./lib/Advertisement");
        var Browser = require("./lib/Browser");
        var ServiceType = require("./lib/ServiceType");
        var validate = require("./lib/validate");
        var resolve = require("./lib/resolve");
        var NetworkInterface = require("./lib/NetworkInterface");

        module.exports = {
          Advertisement: Advertisement,
          Browser: Browser,
          ServiceType: ServiceType,
          tcp: ServiceType.tcp,
          udp: ServiceType.udp,
          all: ServiceType.all,
          validate: validate,
          resolve: resolve.resolve,
          resolveA: resolve.resolveA,
          resolveAAAA: resolve.resolveAAAA,
          resolveSRV: resolve.resolveSRV,
          resolveTXT: resolve.resolveTXT,
          resolveService: resolve.resolveService
        };
      },
      {
        "./lib/Advertisement": 2,
        "./lib/Browser": 3,
        "./lib/NetworkInterface": 9,
        "./lib/ServiceType": 19,
        "./lib/resolve": 28,
        "./lib/validate": 30
      }
    ],
    2: [
      function(require, module, exports) {
        (function(setImmediate, __filename) {
          "use strict";

          function _toConsumableArray(arr) {
            if (Array.isArray(arr)) {
              for (var i = 0, arr2 = Array(arr.length); i < arr.length; i++) {
                arr2[i] = arr[i];
              }
              return arr2;
            } else {
              return Array.from(arr);
            }
          }

          var os = require("os");

          var misc = require("./misc");
          var validate = require("./validate");
          var ServiceType = require("./ServiceType");
          var EventEmitter = require("./EventEmitter");
          var ResourceRecord = require("./ResourceRecord");
          var QueryRecord = require("./QueryRecord");
          var Packet = require("./Packet");
          var sleep = require("./sleep");

          var Responder = require("./Responder");
          var NetworkInterface = require("./NetworkInterface");

          var filename = require("path").basename(__filename);
          var debug = require("./debug")("dnssd:" + filename);

          var RType = require("./constants").RType;
          var STATE = { STOPPED: "stopped", STARTED: "started" };

          /**
           * Creates a new Advertisement
           *
           * @emits 'error'
           * @emits 'stopped' when the advertisement is stopped
           * @emits 'instanceRenamed' when the service instance is renamed
           * @emits 'hostRenamed' when the hostname has to be renamed
           *
           * @param {ServiceType|Object|String|Array} type - type of service to advertise
           * @param {Number}                          port - port to advertise
           *
           * @param {Object}   [options]
           * @param {Object}   options.name       - instance name
           * @param {Object}   options.host       - hostname to use
           * @param {Object}   options.txt        - TXT record
           * @param {Object}   options.subtypes   - subtypes to register
           * @param {Object}   options.interface  - interface name or address to use
           */
          function Advertisement(type, port) {
            var options =
              arguments.length > 2 && arguments[2] !== undefined
                ? arguments[2]
                : {};

            if (!(this instanceof Advertisement)) {
              return new Advertisement(type, port, options);
            }

            EventEmitter.call(this);

            // convert argument ServiceType to validate it (might throw)
            var serviceType = !(type instanceof ServiceType)
              ? new ServiceType(type)
              : type;

            // validate other inputs (throws on invalid)
            validate.port(port);

            if (options.txt) validate.txt(options.txt);
            if (options.name) validate.label(options.name, "Instance");
            if (options.host) validate.label(options.host, "Hostname");

            this.serviceName = serviceType.name;
            this.protocol = serviceType.protocol;
            this.subtypes = options.subtypes
              ? options.subtypes
              : serviceType.subtypes;
            this.port = port;
            this.instanceName = options.name || misc.hostname();
            this.hostname = options.host || misc.hostname();
            this.txt = options.txt || {};

            // Domain notes:
            // 1- link-local only, so this is the only possible value
            // 2- "_domain" used instead of "domain" because "domain" is an instance var
            //    in older versions of EventEmitter. Using "domain" messes up `this.emit()`
            this._domain = "local";

            this._id = misc.fqdn(
              this.instanceName,
              this.serviceName,
              this.protocol,
              "local"
            );
            debug(
              'Creating new advertisement for "' + this._id + '" on ' + port
            );

            this.state = STATE.STOPPED;
            this._interface = NetworkInterface.get(options.interface);
            this._defaultAddresses = null;
            this._hostnameResponder = null;
            this._serviceResponder = null;
          }

          Advertisement.prototype = Object.create(EventEmitter.prototype);
          Advertisement.prototype.constructor = Advertisement;

          /**
           * Starts advertisement
           *
           * In order:
           *   - bind interface to multicast port
           *   - make records and advertise this.hostname
           *   - make records and advertise service
           *
           * If the given hostname is already taken by someone else (not including
           * bonjour/avahi on the same machine), the hostname is automatically renamed
           * following the pattern:
           * Name -> Name (2)
           *
           * Services aren't advertised until the hostname has been properly advertised
           * because a service needs a host. Service instance names (this.instanceName)
           * have to be unique and get renamed automatically the same way.
           *
           * @return {this}
           */
          Advertisement.prototype.start = function() {
            var _this = this;

            if (this.state === STATE.STARTED) {
              debug("Advertisement already started!");
              return this;
            }

            debug('Starting advertisement "' + this._id + '"');
            this.state = STATE.STARTED;

            // restart probing process when waking from sleep
            sleep.using(this).on("wake", this._restart);

            // treat interface errors as fatal
            this._interface.using(this).once("error", this._onError);

            this._interface
              .bind()
              .then(function() {
                return _this._getDefaultID();
              })
              .then(function() {
                return _this._advertiseHostname();
              })
              .then(function() {
                return _this._advertiseService();
              })
              .catch(function(err) {
                return _this._onError(err);
              });

            return this;
          };

          /**
           * Stops advertisement
           *
           * Advertisement can do either a clean stop or a forced stop. A clean stop will
           * send goodbye records out so others will know the service is going down. This
           * takes ~1s. Forced goodbyes shut everything down immediately w/o goodbyes.
           *
           * `this._shutdown()` will deregister the advertisement. If the advertisement was
           * the only thing using the interface it will shut down too.
           *
           * @emits 'stopped'
           *
           * @param {Boolean} [forceImmediate]
           */
          Advertisement.prototype.stop = function(forceImmediate, callback) {
            var _this2 = this;

            debug('Stopping advertisement "' + this._id + '"...');
            this.state = STATE.STOPPED;

            var shutdown = function shutdown() {
              _this2._hostnameResponder = null;
              _this2._serviceResponder = null;

              _this2._interface.removeListenersCreatedBy(_this2);
              _this2._interface.stopUsing();
              sleep.removeListenersCreatedBy(_this2);

              debug("Stopped.");

              callback && callback();
              _this2.emit("stopped");
            };

            // If doing a clean stop, responders need to send goodbyes before turning off
            // the interface. Depending on when the advertisment was stopped, it could
            // have one, two, or no active responders that need to send goodbyes
            var numResponders = 0;
            if (this._serviceResponder) numResponders++;
            if (this._hostnameResponder) numResponders++;

            var done = misc.after_n(shutdown, numResponders);

            // immediate shutdown (forced or if there aren't any active responders)
            // or wait for goodbyes on a clean shutdown
            if (forceImmediate || !numResponders) {
              this._serviceResponder && this._serviceResponder.stop();
              this._hostnameResponder && this._hostnameResponder.stop();
              shutdown();
            } else {
              this._serviceResponder && this._serviceResponder.goodbye(done);
              this._hostnameResponder && this._hostnameResponder.goodbye(done);
            }
          };

          /**
           * Updates the adverts TXT record
           * @param {object} txtObj
           */
          Advertisement.prototype.updateTXT = function(txtObj) {
            var _this3 = this;

            // validates txt first, will throw validation errors on bad input
            validate.txt(txtObj);

            // make sure responder handles network requests in event loop before updating
            // (otherwise could have unintended record conflicts)
            setImmediate(function() {
              _this3._serviceResponder.updateEach(RType.TXT, function(record) {
                record.txtRaw = misc.makeRawTXT(txtObj);
                record.txt = misc.makeReadableTXT(txtObj);
              });
            });
          };

          /**
           * Error handler. Does immediate shutdown
           * @emits 'error'
           */
          Advertisement.prototype._onError = function(err) {
            debug('Error on "' + this._id + '", shutting down. Got: \n' + err);

            this.stop(true); // stop immediately
            this.emit("error", err);
          };

          Advertisement.prototype._restart = function() {
            var _this4 = this;

            if (this.state !== STATE.STARTED)
              return debug("Not yet started, skipping");
            debug('Waking from sleep, restarting "' + this._id + '"');

            // stop responders if they exist
            this._serviceResponder && this._serviceResponder.stop();
            this._hostnameResponder && this._hostnameResponder.stop();

            this._hostnameResponder = null;
            this._serviceResponder = null;

            // need to check if active interface has changed
            this._getDefaultID()
              .then(function() {
                return _this4._advertiseHostname();
              })
              .then(function() {
                return _this4._advertiseService();
              })
              .catch(function(err) {
                return _this4._onError(err);
              });
          };

          Advertisement.prototype._getDefaultID = function() {
            var _this5 = this;

            debug("Trying to find the default route (" + this._id + ")");

            return new Promise(function(resolve, reject) {
              var self = _this5;

              var question = new QueryRecord({
                name: misc.fqdn(_this5.hostname, _this5._domain)
              });
              var queryPacket = new Packet();
              queryPacket.setQuestions([question]);

              // try to listen for our own query
              _this5._interface.on("query", function handler(packet) {
                if (packet.isLocal() && packet.equals(queryPacket)) {
                  self._defaultAddresses = Object.values(
                    os.networkInterfaces()
                  ).find(function(intf) {
                    return intf.some(function(_ref) {
                      var address = _ref.address;
                      return address === packet.origin.address;
                    });
                  });

                  if (self._defaultAddresses) {
                    self._interface.off("query", handler);
                    resolve();
                  }
                }
              });

              _this5._interface.send(queryPacket);
              setTimeout(function() {
                return reject(new Error("Timed out getting default route"));
              }, 500);
            });
          };

          /**
           * Advertise the same hostname
           *
           * A new responder is created for this task. A responder is a state machine
           * that will talk to the network to do advertising. Its responsible for a
           * single record set from `_makeAddressRecords` and automatically renames
           * them if conflicts are found.
           *
           * Returns a promise that resolves when a hostname has been authoritatively
           * advertised. Rejects on fatal errors only.
           *
           * @return {Promise}
           */
          Advertisement.prototype._advertiseHostname = function() {
            var _ref2,
              _this6 = this;

            var interfaces = Object.values(os.networkInterfaces());

            var records = this._makeAddressRecords(this._defaultAddresses);
            var bridgeable = (_ref2 = []).concat.apply(
              _ref2,
              _toConsumableArray(
                interfaces.map(function(i) {
                  return _this6._makeAddressRecords(i);
                })
              )
            );

            return new Promise(function(resolve, reject) {
              var responder = new Responder(
                _this6._interface,
                records,
                bridgeable
              );
              _this6._hostnameResponder = responder;

              responder.on("rename", _this6._onHostRename.bind(_this6));
              responder.once("probingComplete", resolve);
              responder.once("error", reject);

              responder.start();
            });
          };

          /**
           * Handles rename events from the interface hostname responder.
           *
           * If a conflict was been found with a proposed hostname, the responder will
           * rename and probe again. This event fires *after* the rename but *before*
           * probing, so the name here isn't guaranteed yet.
           *
           * The hostname responder will update its A/AAAA record set with the new name
           * when it does the renaming. The service responder will need to update the
           * hostname in its SRV record.
           *
           * @emits 'hostRenamed'
           *
           * @param {String} hostname - the new current hostname
           */
          Advertisement.prototype._onHostRename = function(hostname) {
            debug(
              'Hostname renamed to "' + hostname + '" on interface records'
            );

            var target = misc.fqdn(hostname, this._domain);
            this.hostname = hostname;

            if (this._serviceResponder) {
              this._serviceResponder.updateEach(RType.SRV, function(record) {
                record.target = target;
              });
            }

            this.emit("hostRenamed", target);
          };

          /**
           * Advertises the service
           *
           * A new responder is created for this task also. The responder will manage
           * the record set from `_makeServiceRecords` and automatically rename them
           * if conflicts are found.
           *
           * The responder will keeps advertising/responding until `advertisement.stop()`
           * tells it to stop.
           *
           * @emits 'instanceRenamed' when the service instance is renamed
           */
          Advertisement.prototype._advertiseService = function() {
            var _this7 = this;

            var records = this._makeServiceRecords();

            var responder = new Responder(this._interface, records);
            this._serviceResponder = responder;

            responder.on("rename", function(instance) {
              debug('Service instance had to be renamed to "' + instance + '"');
              _this7._id = misc.fqdn(
                instance,
                _this7.serviceName,
                _this7.protocol,
                "local"
              );
              _this7.instanceName = instance;
              _this7.emit("instanceRenamed", instance);
            });

            responder.once("probingComplete", function() {
              debug('Probed successfully, "' + _this7._id + '" now active');
              _this7.emit("active");
            });

            responder.once("error", this._onError.bind(this));
            responder.start();
          };

          /**
           * Make the A/AAAA records that will be used on an interface.
           *
           * Each interface will have its own A/AAAA records generated because the
           * IPv4/IPv6 addresses will be different on each interface.
           *
           * NSEC records are created to show which records are available with this name.
           * This lets others know if an AAAA doesn't exist, for example.
           * (See 8.2.4 Negative Responses or whatever)
           *
           * @param  {NetworkInterface} intf
           * @return {ResourceRecords[]}
           */
          Advertisement.prototype._makeAddressRecords = function(addresses) {
            var name = misc.fqdn(this.hostname, this._domain);

            var As = addresses
              .filter(function(_ref3) {
                var family = _ref3.family;
                return family === "IPv4";
              })
              .map(function(_ref4) {
                var address = _ref4.address;
                return new ResourceRecord.A({ name: name, address: address });
              });

            var AAAAs = addresses
              .filter(function(_ref5) {
                var family = _ref5.family;
                return family === "IPv6";
              })
              .filter(function(_ref6) {
                var address = _ref6.address;
                return address.substr(0, 6).toLowerCase() === "fe80::";
              })
              .map(function(_ref7) {
                var address = _ref7.address;
                return new ResourceRecord.AAAA({
                  name: name,
                  address: address
                });
              });

            var types = [];
            if (As.length) types.push(RType.A);
            if (AAAAs.length) types.push(RType.AAAA);

            var NSEC = new ResourceRecord.NSEC({
              name: name,
              ttl: 120,
              existing: types
            });

            As.forEach(function(A) {
              A.additionals = AAAAs.length
                ? [].concat(_toConsumableArray(AAAAs), [NSEC])
                : [NSEC];
            });

            AAAAs.forEach(function(AAAA) {
              AAAA.additionals = As.length
                ? [].concat(_toConsumableArray(As), [NSEC])
                : [NSEC];
            });

            return [].concat(
              _toConsumableArray(As),
              _toConsumableArray(AAAAs),
              [NSEC]
            );
          };

          /**
           * Make the SRV/TXT/PTR records that will be used on an interface.
           *
           * Each interface will have its own SRV/TXT/PTR records generated because
           * these records are dependent on the A/AAAA hostname records, which are
           * different for each hostname.
           *
           * NSEC records are created to show which records are available with this name.
           *
           * @return {ResourceRecords[]}
           */
          Advertisement.prototype._makeServiceRecords = function() {
            var records = [];
            var interfaceRecords = this._hostnameResponder.getRecords();

            // enumerator  : "_services._dns-sd._udp.local."
            // registration: "_http._tcp.local."
            // serviceName : "A web page._http._tcp.local."
            var enumerator = misc.fqdn("_services._dns-sd._udp", this._domain);
            var registration = misc.fqdn(
              this.serviceName,
              this.protocol,
              this._domain
            );
            var serviceName = misc.fqdn(this.instanceName, registration);

            var NSEC = new ResourceRecord.NSEC({
              name: serviceName,
              existing: [RType.SRV, RType.TXT]
            });

            var SRV = new ResourceRecord.SRV({
              name: serviceName,
              target: misc.fqdn(this.hostname, this._domain),
              port: this.port,
              additionals: [NSEC].concat(_toConsumableArray(interfaceRecords))
            });

            var TXT = new ResourceRecord.TXT({
              name: serviceName,
              additionals: [NSEC],
              txt: this.txt
            });

            records.push(SRV);
            records.push(TXT);
            records.push(NSEC);

            records.push(
              new ResourceRecord.PTR({
                name: registration,
                PTRDName: serviceName,
                additionals: [SRV, TXT, NSEC].concat(
                  _toConsumableArray(interfaceRecords)
                )
              })
            );

            records.push(
              new ResourceRecord.PTR({
                name: enumerator,
                PTRDName: registration
              })
            );

            // ex: "_printer.sub._http._tcp.local."
            this.subtypes.forEach(function(subType) {
              records.push(
                new ResourceRecord.PTR({
                  name: misc.fqdn(subType, "_sub", registration),
                  PTRDName: serviceName,
                  additionals: [SRV, TXT, NSEC].concat(
                    _toConsumableArray(interfaceRecords)
                  )
                })
              );
            });

            return records;
          };

          module.exports = Advertisement;
        }.call(
          this,
          require("timers").setImmediate,
          "/../dnssd.js/lib/Advertisement.js"
        ));
      },
      {
        "./EventEmitter": 6,
        "./NetworkInterface": 9,
        "./Packet": 10,
        "./QueryRecord": 13,
        "./ResourceRecord": 15,
        "./Responder": 16,
        "./ServiceType": 19,
        "./constants": 22,
        "./debug": 24,
        "./misc": 27,
        "./sleep": 29,
        "./validate": 30,
        os: 39,
        path: 40,
        timers: 42
      }
    ],
    3: [
      function(require, module, exports) {
        (function(__filename) {
          "use strict";

          var misc = require("./misc");
          var ServiceType = require("./ServiceType");
          var EventEmitter = require("./EventEmitter");

          var ServiceResolver = require("./ServiceResolver");
          var NetworkInterface = require("./NetworkInterface");
          var Query = require("./Query");

          var filename = require("path").basename(__filename);
          var debug = require("./debug")("dnssd:" + filename);

          var RType = require("./constants").RType;
          var STATE = { STOPPED: "stopped", STARTED: "started" };

          /**
           * Creates a new Browser
           *
           * @emits 'serviceUp'
           * @emits 'serviceChanged'
           * @emits 'serviceDown'
           * @emits 'error'
           *
           * @param {ServiceType|Object|String|Array} type - the service to browse
           * @param {Object} [options]
           */
          function Browser(type) {
            var options =
              arguments.length > 1 && arguments[1] !== undefined
                ? arguments[1]
                : {};

            if (!(this instanceof Browser)) return new Browser(type, options);
            EventEmitter.call(this);

            // convert argument ServiceType to validate it (might throw)
            var serviceType =
              type instanceof ServiceType ? type : new ServiceType(type);

            // can't search for multiple subtypes at the same time
            if (serviceType.subtypes.length > 1) {
              throw new Error(
                "Too many subtypes. Can only browse one at a time."
              );
            }

            this._id = serviceType.toString();
            debug('Creating new browser for "' + this._id + '"');

            this._resolvers = {}; // active service resolvers (when browsing services)
            this._serviceTypes = {}; // active service types (when browsing service types)
            this._protocol = serviceType.protocol;
            this._serviceName = serviceType.name;
            this._subtype = serviceType.subtypes[0];
            this._isWildcard = serviceType.isEnumerator;
            this._domain = options.domain || "local.";
            this._maintain = "maintain" in options ? options.maintain : true;
            this._resolve = "resolve" in options ? options.resolve : true;
            this._interface = NetworkInterface.get(options.interface);
            this._state = STATE.STOPPED;

            // emitter used to stop child queries instead of holding onto a reference
            // for each one
            this._offswitch = new EventEmitter();
          }

          Browser.prototype = Object.create(EventEmitter.prototype);
          Browser.prototype.constructor = Browser;

          /**
           * Starts browser
           * @return {this}
           */
          Browser.prototype.start = function() {
            var _this = this;

            if (this._state === STATE.STARTED) {
              debug("Browser already started!");
              return this;
            }

            debug('Starting browser for "' + this._id + '"');
            this._state = STATE.STARTED;

            // listen for fatal errors on interface
            this._interface.using(this).once("error", this._onError);

            this._interface
              .bind()
              .then(function() {
                return _this._startQuery();
              })
              .catch(function(err) {
                return _this._onError(err);
              });

            return this;
          };

          /**
           * Stops browser.
           *
           * Browser shutdown has to:
           *   - shut down all child service resolvers (they're no longer needed)
           *   - stop the ongoing browsing queries on all interfaces
           *   - remove all listeners since the browser is down
           *   - deregister from the interfaces so they can shut down if needed
           */
          Browser.prototype.stop = function() {
            debug('Stopping browser for "' + this._id + '"');

            this._interface.removeListenersCreatedBy(this);
            this._interface.stopUsing();

            debug("Sending stop signal to active queries");
            this._offswitch.emit("stop");

            // because resolver.stop()'s will trigger serviceDown:
            this.removeAllListeners("serviceDown");
            Object.values(this._resolvers).forEach(function(resolver) {
              return resolver.stop();
            });

            this._state = STATE.STOPPED;
            this._resolvers = {};
            this._serviceTypes = {};
          };

          /**
           * Get a list of currently available services
           * @return {Objects[]}
           */
          Browser.prototype.list = function() {
            // if browsing service types
            if (this._isWildcard) {
              return Object.values(this._serviceTypes);
            }

            return Object.values(this._resolvers)
              .filter(function(resolver) {
                return resolver.isResolved();
              })
              .map(function(resolver) {
                return resolver.service();
              });
          };

          /**
           * Error handler
           * @emits 'error'
           */
          Browser.prototype._onError = function(err) {
            debug('Error on "' + this._id + '", shutting down. Got: \n' + err);

            this.stop();
            this.emit("error", err);
          };

          /**
           * Starts the query for either services (like each available printer)
           * or service types using enumerator (listing all mDNS service on a network).
           * Queries are sent out on each network interface the browser uses.
           */
          Browser.prototype._startQuery = function() {
            var name = misc.fqdn(
              this._serviceName,
              this._protocol,
              this._domain
            );

            if (this._subtype) name = misc.fqdn(this._subtype, "_sub", name);

            var question = { name: name, qtype: RType.PTR };

            var answerHandler = this._isWildcard
              ? this._addServiceType.bind(this)
              : this._addService.bind(this);

            // start sending continuous, ongoing queries for services
            new Query(this._interface, this._offswitch)
              .add(question)
              .on("answer", answerHandler)
              .start();
          };

          /**
           * Answer handler for service types. Adds type and alerts user.
           *
           * @emits 'serviceUp' with new service types
           * @param {ResourceRecord} answer
           */
          Browser.prototype._addServiceType = function(answer) {
            var name = answer.PTRDName;

            if (this._state === STATE.STOPPED)
              return debug.v("Already stopped, ignoring");
            if (answer.ttl === 0) return debug.v("TTL=0, ignoring");
            if (this._serviceTypes[name])
              return debug.v("Already found, ignoring");

            debug('Found new service type: "' + name + '"');

            var _misc$parse = misc.parse(name),
              service = _misc$parse.service,
              protocol = _misc$parse.protocol;

            // remove any leading underscores for users

            service = service.replace(/^_/, "");
            protocol = protocol.replace(/^_/, "");

            var serviceType = { name: service, protocol: protocol };

            this._serviceTypes[name] = serviceType;
            this.emit("serviceUp", serviceType);
          };

          /**
           * Answer handler for services.
           *
           * New found services cause a ServiceResolve to be created. The resolver
           * parse the additionals and query out for an records needed to fully
           * describe the service (hostname, IP, port, TXT).
           *
           * @emits 'serviceUp'      when a new service is found
           * @emits 'serviceChanged' when a resolved service changes data (IP, etc.)
           * @emits 'serviceDown'    when a resolved service goes down
           *
           * @param {ResourceRecord}   answer        - the record that has service data
           * @param {ResourceRecord[]} [additionals] - other records that might be related
           */
          Browser.prototype._addService = function(answer, additionals) {
            var _this2 = this;

            var name = answer.PTRDName;

            if (this._state === STATE.STOPPED)
              return debug.v("Already stopped, ignoring");
            if (answer.ttl === 0) return debug.v("TTL=0, ignoring");
            if (this._resolvers[name])
              return debug.v("Already found, ignoring");

            debug('Found new service: "' + name + '"');

            if (!this._resolve) {
              this.emit("serviceUp", misc.parse(name).instance);
              return;
            }

            var resolver = new ServiceResolver(name, this._interface);
            this._resolvers[name] = resolver;

            resolver.once("resolved", function() {
              debug("Service up");

              // - stop resolvers that dont need to be maintained
              // - only emit 'serviceDown' events once services that have been resolved
              if (!_this2._maintain) {
                resolver.stop();
                _this2._resolvers[name] = null;
              } else {
                resolver.once("down", function() {
                  return _this2.emit("serviceDown", resolver.service());
                });
              }

              _this2.emit("serviceUp", resolver.service());
            });

            resolver.on("updated", function() {
              debug("Service updated");
              _this2.emit("serviceChanged", resolver.service());
            });

            resolver.once("down", function() {
              debug("Service down");
              delete _this2._resolvers[name];
            });

            resolver.start(additionals);
          };

          module.exports = Browser;
        }.call(this, "/../dnssd.js/lib/Browser.js"));
      },
      {
        "./EventEmitter": 6,
        "./NetworkInterface": 9,
        "./Query": 12,
        "./ServiceResolver": 18,
        "./ServiceType": 19,
        "./constants": 22,
        "./debug": 24,
        "./misc": 27,
        path: 40
      }
    ],
    4: [
      function(require, module, exports) {
        (function(Buffer) {
          "use strict";

          var _createClass = (function() {
            function defineProperties(target, props) {
              for (var i = 0; i < props.length; i++) {
                var descriptor = props[i];
                descriptor.enumerable = descriptor.enumerable || false;
                descriptor.configurable = true;
                if ("value" in descriptor) descriptor.writable = true;
                Object.defineProperty(target, descriptor.key, descriptor);
              }
            }
            return function(Constructor, protoProps, staticProps) {
              if (protoProps)
                defineProperties(Constructor.prototype, protoProps);
              if (staticProps) defineProperties(Constructor, staticProps);
              return Constructor;
            };
          })();

          function _toConsumableArray(arr) {
            if (Array.isArray(arr)) {
              for (var i = 0, arr2 = Array(arr.length); i < arr.length; i++) {
                arr2[i] = arr[i];
              }
              return arr2;
            } else {
              return Array.from(arr);
            }
          }

          function _classCallCheck(instance, Constructor) {
            if (!(instance instanceof Constructor)) {
              throw new TypeError("Cannot call a class as a function");
            }
          }

          /**
           * Wraps a buffer for easier reading / writing without keeping track of offsets.
           * @class
           *
           * instead of:
           *   buffer.writeUInt8(1, 0);
           *   buffer.writeUInt8(2, 1);
           *   buffer.writeUInt8(3, 2);
           *
           * do:
           *   wrapper.writeUInt8(1);
           *   wrapper.writeUInt8(2);
           *   wrapper.writeUInt8(3);
           */
          var BufferWrapper = (function() {
            /**
             * @param {Buffer}  [buffer]
             * @param {integer} [position]
             */
            function BufferWrapper(buffer) {
              var position =
                arguments.length > 1 && arguments[1] !== undefined
                  ? arguments[1]
                  : 0;

              _classCallCheck(this, BufferWrapper);

              this.buffer = buffer || Buffer.alloc(512);
              this.position = position;
            }

            _createClass(BufferWrapper, [
              {
                key: "readUInt8",
                value: function readUInt8() {
                  var value = this.buffer.readUInt8(this.position);
                  this.position += 1;
                  return value;
                }
              },
              {
                key: "writeUInt8",
                value: function writeUInt8(value) {
                  this._checkLength(1);
                  this.buffer.writeUInt8(value, this.position);
                  this.position += 1;
                }
              },
              {
                key: "readUInt16BE",
                value: function readUInt16BE() {
                  var value = this.buffer.readUInt16BE(this.position);
                  this.position += 2;
                  return value;
                }
              },
              {
                key: "writeUInt16BE",
                value: function writeUInt16BE(value) {
                  this._checkLength(2);
                  this.buffer.writeUInt16BE(value, this.position);
                  this.position += 2;
                }
              },
              {
                key: "readUInt32BE",
                value: function readUInt32BE() {
                  var value = this.buffer.readUInt32BE(this.position);
                  this.position += 4;
                  return value;
                }
              },
              {
                key: "writeUInt32BE",
                value: function writeUInt32BE(value) {
                  this._checkLength(4);
                  this.buffer.writeUInt32BE(value, this.position);
                  this.position += 4;
                }
              },
              {
                key: "readUIntBE",
                value: function readUIntBE(len) {
                  var value = this.buffer.readUIntBE(this.position, len);
                  this.position += len;
                  return value;
                }
              },
              {
                key: "writeUIntBE",
                value: function writeUIntBE(value, len) {
                  this._checkLength(len);
                  this.buffer.writeUIntBE(value, this.position, len);
                  this.position += len;
                }
              },
              {
                key: "readString",
                value: function readString(len) {
                  var str = this.buffer.toString(
                    "utf8",
                    this.position,
                    this.position + len
                  );
                  this.position += len;
                  return str;
                }
              },
              {
                key: "writeString",
                value: function writeString(str) {
                  var len = Buffer.byteLength(str);
                  this._checkLength(len);
                  this.buffer.write(str, this.position);
                  this.position += len;
                }

                /**
                 * Returns a sub portion of the wrapped buffer
                 * @param  {integer} len
                 * @return {Buffer}
                 */
              },
              {
                key: "read",
                value: function read(len) {
                  var buf = Buffer.alloc(len).fill(0);
                  this.buffer.copy(buf, 0, this.position);
                  this.position += len;
                  return buf;
                }

                /**
                 * Writes another buffer onto the wrapped buffer
                 * @param {Buffer} buffer
                 */
              },
              {
                key: "add",
                value: function add(buffer) {
                  this._checkLength(buffer.length);
                  buffer.copy(this.buffer, this.position);
                  this.position += buffer.length;
                }
              },
              {
                key: "seek",
                value: function seek(position) {
                  this.position = position;
                }
              },
              {
                key: "skip",
                value: function skip(len) {
                  this.position += len;
                }
              },
              {
                key: "tell",
                value: function tell() {
                  return this.position;
                }
              },
              {
                key: "remaining",
                value: function remaining() {
                  return this.buffer.length - this.position;
                }
              },
              {
                key: "unwrap",
                value: function unwrap() {
                  return this.buffer.slice(0, this.position);
                }
              },
              {
                key: "_checkLength",
                value: function _checkLength(len) {
                  var needed = len - this.remaining();
                  var amount = needed > 512 ? needed * 1.5 : 512;

                  if (needed > 0) this._grow(amount);
                }
              },
              {
                key: "_grow",
                value: function _grow(amount) {
                  this.buffer = Buffer.concat([
                    this.buffer,
                    Buffer.alloc(amount).fill(0)
                  ]);
                }
              },
              {
                key: "indexOf",
                value: function indexOf(needle) {
                  // limit indexOf search up to current position in buffer, no need to
                  // search for stuff after this.position
                  var haystack = this.buffer.slice(0, this.position);

                  if (!haystack.length || !needle.length) return -1;
                  if (needle.length > haystack.length) return -1;

                  // use node's indexof if this version has it
                  if (typeof Buffer.prototype.indexOf === "function") {
                    return haystack.indexOf(needle);
                  }

                  // otherwise do naive search
                  var maxIndex = haystack.length - needle.length;
                  var index = 0;
                  var pos = 0;

                  for (; index <= maxIndex; index++, pos = 0) {
                    while (haystack[index + pos] === needle[pos]) {
                      if (++pos === needle.length) return index;
                    }
                  }

                  return -1;
                }

                /**
                 * Reads a fully qualified domain name from the buffer following the dns
                 * message format / compression style.
                 *
                 * Basic:
                 * Each label is preceded by an uint8 specifying the length of the label,
                 * finishing with a 0 which indicates the root label.
                 *
                 * +---+------+---+--------+---+-----+---+
                 * | 3 | wwww | 6 | google | 3 | com | 0 |  -->  www.google.com.
                 * +---+------+---+--------+---+-----+---+
                 *
                 * Compression:
                 * A pointer is used to point to the location of the previously written labels.
                 * If a length byte is > 192 (0xC0) then it means its a pointer to other
                 * labels and not a length marker. The pointer is 2 octets long.
                 *
                 * +---+------+-------------+
                 * | 3 | wwww | 0xC000 + 34 |  -->  www.google.com.
                 * +---+------+-------------+
                 *                       ^-- the "google.com." part can be found @ offset 34
                 *
                 * @return {string}
                 */
              },
              {
                key: "readFQDN",
                value: function readFQDN() {
                  var labels = [];
                  var len = void 0,
                    farthest = void 0;

                  while (this.remaining() >= 0 && (len = this.readUInt8())) {
                    // Handle dns compression. If the length is > 192, it means its a pointer.
                    // The pointer points to a previous position in the buffer to move to and
                    // read from. Pointer (a int16be) = 0xC000 + position
                    if (len < 192) {
                      labels.push(this.readString(len));
                    } else {
                      var position = (len << 8) + this.readUInt8() - 0xc000;

                      // If a pointer was found, keep track of the farthest position reached
                      // (the current position) before following the pointers so we can return
                      // to it later after following all the compression pointers
                      if (!farthest) farthest = this.position;
                      this.seek(position);
                    }
                  }

                  // reset to correct position after following pointers (if any)
                  if (farthest) this.seek(farthest);

                  return labels.join(".") + "."; // + root label
                }

                /**
                 * Writes a fully qualified domain name
                 * Same rules as readFQDN above. Does compression.
                 *
                 * @param {string} name
                 */
              },
              {
                key: "writeFQDN",
                value: function writeFQDN(name) {
                  var _this = this;

                  // convert name into an array of buffers
                  var labels = name
                    .split(".")
                    .filter(function(s) {
                      return !!s;
                    })
                    .map(function(label) {
                      var len = Buffer.byteLength(label);
                      var buf = Buffer.alloc(1 + len);

                      buf.writeUInt8(len, 0);
                      buf.write(label, 1);

                      return buf;
                    });

                  // add root label (a single ".") to the end (zero length label = 0)
                  labels.push(Buffer.alloc(1));

                  // compress
                  var compressed = this._getCompressedLabels(labels);
                  compressed.forEach(function(label) {
                    return _this.add(label);
                  });
                }

                /**
                 * Finds a compressed version of given labels within the buffer
                 *
                 * Checks if a sub section has been written before, starting with all labels
                 * and removing the first label on each successive search until a match (index)
                 * is found, or until NO match is found.
                 *
                 * Ex:
                 *
                 * 1st pass: Instance._service._tcp.local
                 * 2nd pass: _service._tcp.local
                 * 3rd pass: _tcp.local
                 *            ^-- found "_tcp.local" @ 34, try to compress more
                 *
                 * 4th pass: Instance._service.[0xC000 + 34]
                 * 5th pass: _service.[0xC000 + 34]
                 *            ^-- found "_service.[0xC000 + 34]" @ 52, try to compress more
                 *
                 * 6th pass: Instance.[0xC000 + 52]
                 *
                 * Nothing else found, returns [Instance, 0xC000+52]
                 *
                 * @param  {Buffer[]} labels
                 * @return {Buffer[]} - compressed version
                 */
              },
              {
                key: "_getCompressedLabels",
                value: function _getCompressedLabels(labels) {
                  var copy = [].concat(_toConsumableArray(labels));
                  var wrapper = this;

                  function compress(lastPointer) {
                    // re-loop on each compression attempt
                    copy.forEach(function(label, index) {
                      // if a pointer was found on the last compress call, don't bother trying
                      // to find a previous instance of a pointer, it doesn't do any good.
                      // no need to change [0xC000 + 54] pointer to a [0xC000 + 23] pointer
                      if (lastPointer && label === lastPointer) return;
                      if (label.length === 1 && label[0] === 0) return;

                      var subset = copy.slice(index);
                      var pos = wrapper.indexOf(Buffer.concat(subset));

                      if (!!~pos) {
                        var pointer = Buffer.alloc(2);
                        pointer.writeUInt16BE(0xc000 + pos, 0);

                        // drop this label and everything after it (stopping forEach loop)
                        // put the pointer there instead
                        copy.splice(index, copy.length - index);
                        copy.push(pointer);

                        compress(pointer); // try to compress some more
                      }
                    });
                  }

                  compress();
                  return copy;
                }
              }
            ]);

            return BufferWrapper;
          })();

          module.exports = BufferWrapper;
        }.call(this, require("buffer").Buffer));
      },
      { buffer: 36 }
    ],
    5: [
      function(require, module, exports) {
        (function(__filename) {
          "use strict";

          var _createClass = (function() {
            function defineProperties(target, props) {
              for (var i = 0; i < props.length; i++) {
                var descriptor = props[i];
                descriptor.enumerable = descriptor.enumerable || false;
                descriptor.configurable = true;
                if ("value" in descriptor) descriptor.writable = true;
                Object.defineProperty(target, descriptor.key, descriptor);
              }
            }
            return function(Constructor, protoProps, staticProps) {
              if (protoProps)
                defineProperties(Constructor.prototype, protoProps);
              if (staticProps) defineProperties(Constructor, staticProps);
              return Constructor;
            };
          })();

          function _classCallCheck(instance, Constructor) {
            if (!(instance instanceof Constructor)) {
              throw new TypeError("Cannot call a class as a function");
            }
          }

          function _possibleConstructorReturn(self, call) {
            if (!self) {
              throw new ReferenceError(
                "this hasn't been initialised - super() hasn't been called"
              );
            }
            return call &&
              (typeof call === "object" || typeof call === "function")
              ? call
              : self;
          }

          function _inherits(subClass, superClass) {
            if (typeof superClass !== "function" && superClass !== null) {
              throw new TypeError(
                "Super expression must either be null or a function, not " +
                  typeof superClass
              );
            }
            subClass.prototype = Object.create(
              superClass && superClass.prototype,
              {
                constructor: {
                  value: subClass,
                  enumerable: false,
                  writable: true,
                  configurable: true
                }
              }
            );
            if (superClass)
              Object.setPrototypeOf
                ? Object.setPrototypeOf(subClass, superClass)
                : (subClass.__proto__ = superClass);
          }

          var os = require("os");
          var dgram = require("dgram-browserify");

          var NetworkInterface = require("./NetworkInterface");

          var filename = require("path").basename(__filename);
          var debug = require("./debug")("dnssd:" + filename);

          /**
           * Creates a network interface obj using some ephemeral port like 51254
           * @class
           * @extends NetworkInterface
           *
           * Used for dnssd.resolve() functions where you only need to send a query
           * packet, get an answer, and shut down. (Sending packets from port 5353
           * would indicate a fully compliant responder). Packets sent by these interface
           * objects will be treated as 'legacy' queries by other responders.
           */

          var DisposableInterface = (function(_NetworkInterface) {
            _inherits(DisposableInterface, _NetworkInterface);

            function DisposableInterface(name, addresses) {
              _classCallCheck(this, DisposableInterface);

              debug("Creating new DisposableInterface on " + name + ":");

              var _this = _possibleConstructorReturn(
                this,
                (
                  DisposableInterface.__proto__ ||
                  Object.getPrototypeOf(DisposableInterface)
                ).call(this, name)
              );

              _this._addresses = addresses;
              return _this;
            }

            /**
             * Creates/returns DisposableInterfaces from a name or names of interfaces.
             * Always returns an array of em.
             * @static
             *
             * Ex:
             * > const interfaces = DisposableInterface.createEach('eth0');
             * > const interfaces = DisposableInterface.createEach(['eth0', 'wlan0']);
             *
             * @param  {string|string[]} args
             * @return {DisposableInterface[]}
             */

            _createClass(
              DisposableInterface,
              [
                {
                  key: "bind",
                  value: function bind() {
                    var _this2 = this;

                    return Promise.all(
                      this._addresses.map(function(addr) {
                        return _this2._bindSocket(addr);
                      })
                    ).then(function() {
                      debug("Interface " + _this2._id + " now bound");
                      _this2._isBound = true;
                    });
                  }
                },
                {
                  key: "_bindSocket",
                  value: function _bindSocket(address) {
                    var _this3 = this;

                    var isPending = true;

                    var promise = new Promise(function(resolve, reject) {
                      var socketType =
                        address.family === "IPv6" ? "udp6" : "udp4";
                      var socket = dgram.createSocket({ type: socketType });

                      socket.on("error", function(err) {
                        if (isPending) reject(err);
                        else _this3._onError(err);
                      });

                      socket.on("close", function() {
                        _this3._onError(
                          new Error("Socket closed unexpectedly")
                        );
                      });

                      socket.on("message", _this3._onMessage.bind(_this3));

                      socket.on("listening", function() {
                        var sinfo = socket.address();
                        debug(
                          _this3._id +
                            " listening on " +
                            sinfo.address +
                            ":" +
                            sinfo.port
                        );

                        _this3._sockets.push(socket);
                        resolve();
                      });

                      socket.bind({ address: address.address });
                    });

                    return promise.then(function() {
                      isPending = false;
                    });
                  }
                }
              ],
              [
                {
                  key: "create",
                  value: function create(name) {
                    var addresses = [{ adderss: "0.0.0.0", family: "IPv4" }];

                    return name
                      ? new DisposableInterface(
                          name,
                          os.networkInterfaces()[name]
                        )
                      : new DisposableInterface("INADDR_ANY", addresses);
                  }

                  /**
                   * Checks if the names are interfaces that exist in os.networkInterfaces()
                   * @static
                   *
                   * @param  {string|string[]} arg - interface name/names
                   * @return {boolean}
                   */
                },
                {
                  key: "isValidName",
                  value: function isValidName(name) {
                    if (!name || typeof name !== "string") return false;
                    return !!~Object.keys(os.networkInterfaces()).indexOf(name);
                  }
                }
              ]
            );

            return DisposableInterface;
          })(NetworkInterface);

          module.exports = DisposableInterface;
        }.call(this, "/../dnssd.js/lib/DisposableInterface.js"));
      },
      {
        "./NetworkInterface": 9,
        "./debug": 24,
        "dgram-browserify": 31,
        os: 39,
        path: 40
      }
    ],
    6: [
      function(require, module, exports) {
        "use strict";

        var EventEmitter = require("events").EventEmitter;

        /**
         * Node EventEmitter + some convenience methods
         * @class
         *
         * This emitter lets you do this:
         *
         * > emitter.using(obj)
         * >   .on('event', obj.handleEvent)
         * >   .on('thing', obj.doThing)
         * >
         * > emitter.removeListenersCreatedBy(obj)
         *
         * Because this doesn't work:
         *
         * > emitter.on('event', this.fn.bind(this))
         * > emitter.removeListener('event', this.fn.bind(this))
         *
         * @param {object} options
         */
        function Emitter() {
          var options =
            arguments.length > 0 && arguments[0] !== undefined
              ? arguments[0]
              : {};

          // this._eventContexts is a map of maps that track of listener/event pairs
          // created by some object / context
          //
          // {
          //   context: {
          //     listener_fn: event type,
          //   },
          // }
          //
          this._eventContexts = new Map();
          this.setMaxListeners(options.maxListeners || 0);
        }

        Emitter.prototype = Object.create(EventEmitter.prototype);
        Emitter.prototype.constructor = Emitter;

        /**
         * Adds a listener that is bound to a context
         */
        Emitter.prototype.using = function(context) {
          var emitter = this;

          var contextSpecific = {
            on: function on(event, fn) {
              var listener = fn.bind(context);
              var listeners = emitter._eventContexts.get(context) || new Map();

              // add listener/event to context list
              listeners.set(listener, event);
              emitter._eventContexts.set(context, listeners);

              // register event
              emitter.on(event, listener);

              return contextSpecific;
            },
            once: function once(event, fn) {
              var listener = fn.bind(context);
              var listeners = emitter._eventContexts.get(context) || new Map();

              // add listener/event to context list
              listeners.set(listener, event);
              emitter._eventContexts.set(context, listeners);

              // register event
              emitter.once(event, listener);

              return contextSpecific;
            }
          };

          return contextSpecific;
        };

        Emitter.prototype.off = function(event, fn) {
          this.removeListener(event, fn);
          return this;
        };

        /**
         * Remove all listeners that were created by / assigned to given context
         */
        Emitter.prototype.removeListenersCreatedBy = function(context) {
          var _this = this;

          var listeners = this._eventContexts.get(context) || [];

          listeners.forEach(function(event, fn) {
            return _this.off(event, fn);
          });
          this._eventContexts.delete(context);

          return this;
        };

        module.exports = Emitter;
      },
      { events: 37 }
    ],
    7: [
      function(require, module, exports) {
        (function(__filename) {
          "use strict";

          var _createClass = (function() {
            function defineProperties(target, props) {
              for (var i = 0; i < props.length; i++) {
                var descriptor = props[i];
                descriptor.enumerable = descriptor.enumerable || false;
                descriptor.configurable = true;
                if ("value" in descriptor) descriptor.writable = true;
                Object.defineProperty(target, descriptor.key, descriptor);
              }
            }
            return function(Constructor, protoProps, staticProps) {
              if (protoProps)
                defineProperties(Constructor.prototype, protoProps);
              if (staticProps) defineProperties(Constructor, staticProps);
              return Constructor;
            };
          })();

          function _toConsumableArray(arr) {
            if (Array.isArray(arr)) {
              for (var i = 0, arr2 = Array(arr.length); i < arr.length; i++) {
                arr2[i] = arr[i];
              }
              return arr2;
            } else {
              return Array.from(arr);
            }
          }

          function _classCallCheck(instance, Constructor) {
            if (!(instance instanceof Constructor)) {
              throw new TypeError("Cannot call a class as a function");
            }
          }

          function _possibleConstructorReturn(self, call) {
            if (!self) {
              throw new ReferenceError(
                "this hasn't been initialised - super() hasn't been called"
              );
            }
            return call &&
              (typeof call === "object" || typeof call === "function")
              ? call
              : self;
          }

          function _inherits(subClass, superClass) {
            if (typeof superClass !== "function" && superClass !== null) {
              throw new TypeError(
                "Super expression must either be null or a function, not " +
                  typeof superClass
              );
            }
            subClass.prototype = Object.create(
              superClass && superClass.prototype,
              {
                constructor: {
                  value: subClass,
                  enumerable: false,
                  writable: true,
                  configurable: true
                }
              }
            );
            if (superClass)
              Object.setPrototypeOf
                ? Object.setPrototypeOf(subClass, superClass)
                : (subClass.__proto__ = superClass);
          }

          var EventEmitter = require("./EventEmitter");
          var TimerContainer = require("./TimerContainer");

          var filename = require("path").basename(__filename);
          var debug = require("./debug")("dnssd:" + filename);

          var ONE_SECOND = 1000;

          /**
           * @class
           * @extends EventEmitter
           *
           * ExpiringRecordCollection is a set collection for resource records or
           * query records. Uniqueness is determined by a record's hash property,
           * which is a hash of a records name, type, class, and rdata. Records
           * are evicted from the collection as their TTLs expire.
           *
           * Since there may be several records with the same name, type, and class,
           * but different rdata, within a record set (e.g. PTR records for a service
           * type), related records are tracked in this._related.
           *
           * This collection emits 'reissue' and 'expired' events as records TTLs
           * decrease towards expiration. Reissues are emitted at 80%, 85%, 90% and 95%
           * of each records TTL. Re-adding a record refreshes the TTL.
           *
           * @emits 'expired'
           * @emits 'reissue'
           */

          var ExpiringRecordCollection = (function(_EventEmitter) {
            _inherits(ExpiringRecordCollection, _EventEmitter);

            /**
             * @param {ResourceRecord[]} [records] - optional starting records
             * @param {string} [description]       - optional description for debugging
             */
            function ExpiringRecordCollection(records, description) {
              _classCallCheck(this, ExpiringRecordCollection);

              // make debugging easier, who owns this / what it is
              var _this = _possibleConstructorReturn(
                this,
                (
                  ExpiringRecordCollection.__proto__ ||
                  Object.getPrototypeOf(ExpiringRecordCollection)
                ).call(this)
              );

              _this._desc = description;

              _this._records = {}; // record.hash: record
              _this._related = {}; // record.namehash: Set() of record hashes
              _this._insertionTime = {}; // record.hash: Date.now()
              _this._timerContainers = {}; // record.hash: new TimerContainer()

              _this.size = 0;
              if (records) _this.addEach(records);
              return _this;
            }

            /**
             * Adds record. Re-added records refresh TTL expiration timers.
             * @param {ResourceRecord} record
             */

            _createClass(ExpiringRecordCollection, [
              {
                key: "add",
                value: function add(record) {
                  var id = record.hash;
                  var group = record.namehash;

                  // expire TTL=0 goodbye records instead
                  if (record.ttl === 0) return this.setToExpire(record);

                  debug.v("#add(): %s", record);
                  debug.v("    to: " + this._desc);

                  // only increment size if the record is new
                  if (!this._records[id]) this.size++;

                  // keep track of related records (same name, type, and class)
                  if (!this._related[group]) this._related[group] = new Set();

                  // remove any old timers
                  if (this._timerContainers[id])
                    this._timerContainers[id].clear();

                  this._records[id] = record;
                  this._related[group].add(id);
                  this._insertionTime[id] = Date.now();
                  this._timerContainers[id] = new TimerContainer();

                  // do reissue/expired timers
                  this._schedule(record);
                }
              },
              {
                key: "addEach",
                value: function addEach(records) {
                  var _this2 = this;

                  records.forEach(function(record) {
                    return _this2.add(record);
                  });
                }
              },
              {
                key: "has",
                value: function has(record) {
                  return Object.hasOwnProperty.call(this._records, record.hash);
                }

                /**
                 * Checks if a record was added to the collection within a given range
                 *
                 * @param  {ResourceRecord} record
                 * @param  {number}         range - in *seconds*
                 * @return {boolean}
                 */
              },
              {
                key: "hasAddedWithin",
                value: function hasAddedWithin(record, range) {
                  var then = this._insertionTime[record.hash];

                  return (
                    Number(parseFloat(then)) === then &&
                    range * ONE_SECOND >= Date.now() - then
                  );
                }

                /**
                 * Returns a *clone* of originally added record that matches requested record.
                 * The clone's TTL is reduced to the current TTL. A clone is used so the
                 * original record's TTL isn't modified.
                 *
                 * @param  {ResourceRecord} record
                 * @return {ResourceRecord|undefined}
                 */
              },
              {
                key: "get",
                value: function get(record) {
                  if (!this.has(record)) return undefined;

                  var then = this._insertionTime[record.hash];
                  var elapsed = ~~((Date.now() - then) / ONE_SECOND);
                  var clone = record.clone();

                  clone.ttl -= elapsed;

                  return clone;
                }

                /**
                 * @emits 'expired' w/ the expiring record
                 */
              },
              {
                key: "delete",
                value: function _delete(record) {
                  if (!this.has(record)) return;

                  var id = record.hash;
                  var group = record.namehash;

                  this.size--;
                  this._timerContainers[id].clear();

                  delete this._records[id];
                  delete this._insertionTime[id];
                  delete this._timerContainers[id];

                  if (this._related[group]) this._related[group].delete(id);

                  debug.v("deleting: %s", record);
                  debug.v("    from: " + this._desc);

                  this.emit("expired", record);
                }

                /**
                 * Deletes all records, clears all timers, resets size to 0
                 */
              },
              {
                key: "clear",
                value: function clear() {
                  debug.v("#clear()");

                  this.removeAllListeners();
                  Object.values(this._timerContainers).forEach(function(
                    timers
                  ) {
                    return timers.clear();
                  });

                  this.size = 0;
                  this._records = {};
                  this._related = {};
                  this._insertionTime = {};
                  this._timerContainers = {};
                }

                /**
                 * Sets record to be deleted in 1s, but doesn't immediately delete it
                 */
              },
              {
                key: "setToExpire",
                value: function setToExpire(record) {
                  var _this3 = this;

                  // can't expire unknown records
                  if (!this.has(record)) return;

                  // don't reset expire timer if this gets called again, say due to
                  // repeated goodbyes. only one timer (expire) would be set in this case
                  if (this._timerContainers[record.hash].count() === 1) return;

                  debug.v("#setToExpire(): %s", record);
                  debug.v("            on: " + this._desc);

                  this._timerContainers[record.hash].clear();
                  this._timerContainers[record.hash].set(function() {
                    return _this3.delete(record);
                  }, ONE_SECOND);
                }

                /**
                 * Flushes any other records that have the same name, class, and type
                 * from the collection *if* the records have been in the collection
                 * longer than 1s.
                 */
              },
              {
                key: "flushRelated",
                value: function flushRelated(record) {
                  var _this4 = this;

                  // only flush records that have cache-flush bit set
                  if (!record.isUnique) return;

                  this._getRelatedRecords(record.namehash).forEach(function(
                    related
                  ) {
                    // can't flush itself
                    if (related.equals(record)) return;

                    // only flush records added more than 1s ago
                    if (!_this4.hasAddedWithin(related, 1))
                      _this4.setToExpire(related);
                  });
                }

                /**
                 * Records with original TTLs (not reduced ttl clones)
                 */
              },
              {
                key: "toArray",
                value: function toArray() {
                  return Object.values(this._records);
                }

                /**
                 * Checks if collection contains any other records with the same name, type,
                 * and class but different rdata. Non-unique records always return false & a
                 * record can't conflict with itself
                 *
                 * @param  {ResourceRecord} record
                 * @return {boolean}
                 */
              },
              {
                key: "hasConflictWith",
                value: function hasConflictWith(record) {
                  if (!record.isUnique) return false;

                  return !!this._getRelatedRecords(record.namehash).filter(
                    function(related) {
                      return !related.equals(record);
                    }
                  ).length;
                }

                /**
                 * Finds any records in collection that matches name, type, and class of a
                 * given query. Rejects any records with a TTL below the cutoff percentage.
                 * Returns clones of records to prevent changes to original objects.
                 *
                 * @param  {QueryRecord} query
                 * @param  {number}      [cutoff] - percentage, 0.0 - 1.0
                 * @return {ResourceRecords[]}
                 */
              },
              {
                key: "find",
                value: function find(query) {
                  var cutoff =
                    arguments.length > 1 && arguments[1] !== undefined
                      ? arguments[1]
                      : 0.25;

                  debug.v('#find(): "' + query.name + '" type: ' + query.qtype);
                  debug.v("     in: " + this._desc);

                  return this._filterTTL(
                    this._getRelatedRecords(query.namehash),
                    cutoff
                  );
                }

                /**
                 * Gets all any records in collection with a TTL above the cutoff percentage.
                 * Returns clones of records to prevent changes to original objects.
                 *
                 * @param  {number} [cutoff] - percentage, 0.0 - 1.0
                 * @return {ResouceRecords[]}
                 */
              },
              {
                key: "getAboveTTL",
                value: function getAboveTTL() {
                  var cutoff =
                    arguments.length > 0 && arguments[0] !== undefined
                      ? arguments[0]
                      : 0.25;

                  debug.v("#getAboveTTL(): %" + cutoff * 100);
                  return this._filterTTL(this.toArray(), cutoff);
                }

                /**
                 * Gets records that have same name, type, and class.
                 */
              },
              {
                key: "_getRelatedRecords",
                value: function _getRelatedRecords(namehash) {
                  var _this5 = this;

                  return this._related[namehash] && this._related[namehash].size
                    ? []
                        .concat(_toConsumableArray(this._related[namehash]))
                        .map(function(id) {
                          return _this5._records[id];
                        })
                    : [];
                }

                /**
                 * Filters given records by their TTL.
                 * Returns clones of records to prevent changes to original objects.
                 *
                 * @param  {ResouceRecords[]} records
                 * @param  {number}           cutoff - percentage, 0.0 - 1.0
                 * @return {ResouceRecords[]}
                 */
              },
              {
                key: "_filterTTL",
                value: function _filterTTL(records, cutoff) {
                  var _this6 = this;

                  return records.reduce(function(result, record) {
                    var then = _this6._insertionTime[record.hash];
                    var elapsed = ~~((Date.now() - then) / ONE_SECOND);
                    var percent = (record.ttl - elapsed) / record.ttl;

                    debug.v("└── %s @ %d%", record, ~~(percent * 100));

                    if (percent >= cutoff) {
                      var clone = record.clone();
                      clone.ttl -= elapsed;
                      result.push(clone);
                    }

                    return result;
                  }, []);
                }

                /**
                 * Sets expiration/reissue timers for a record.
                 *
                 * Sets expiration at end of TTL.
                 * Sets reissue events at 80%, 85%, 90%, 95% of records TTL, plus a random
                 * extra 0-2%. (see rfc)
                 *
                 * @emits 'reissue' w/ the record that needs to be refreshed
                 *
                 * @param {ResouceRecords} record
                 */
              },
              {
                key: "_schedule",
                value: function _schedule(record) {
                  var _this7 = this;

                  var id = record.hash;
                  var ttl = record.ttl * ONE_SECOND;

                  var expired = function expired() {
                    return _this7.delete(record);
                  };
                  var reissue = function reissue() {
                    return _this7.emit("reissue", record);
                  };
                  var random = function random(min, max) {
                    return Math.random() * (max - min) + min;
                  };

                  this._timerContainers[id].setLazy(
                    reissue,
                    ttl * random(0.8, 0.82)
                  );
                  this._timerContainers[id].setLazy(
                    reissue,
                    ttl * random(0.85, 0.87)
                  );
                  this._timerContainers[id].setLazy(
                    reissue,
                    ttl * random(0.9, 0.92)
                  );
                  this._timerContainers[id].setLazy(
                    reissue,
                    ttl * random(0.95, 0.97)
                  );
                  this._timerContainers[id].set(expired, ttl);
                }
              }
            ]);

            return ExpiringRecordCollection;
          })(EventEmitter);

          module.exports = ExpiringRecordCollection;
        }.call(this, "/../dnssd.js/lib/ExpiringRecordCollection.js"));
      },
      { "./EventEmitter": 6, "./TimerContainer": 21, "./debug": 24, path: 40 }
    ],
    8: [
      function(require, module, exports) {
        "use strict";

        var _createClass = (function() {
          function defineProperties(target, props) {
            for (var i = 0; i < props.length; i++) {
              var descriptor = props[i];
              descriptor.enumerable = descriptor.enumerable || false;
              descriptor.configurable = true;
              if ("value" in descriptor) descriptor.writable = true;
              Object.defineProperty(target, descriptor.key, descriptor);
            }
          }
          return function(Constructor, protoProps, staticProps) {
            if (protoProps) defineProperties(Constructor.prototype, protoProps);
            if (staticProps) defineProperties(Constructor, staticProps);
            return Constructor;
          };
        })();

        function _classCallCheck(instance, Constructor) {
          if (!(instance instanceof Constructor)) {
            throw new TypeError("Cannot call a class as a function");
          }
        }

        /**
         * const mutex = new Mutex();
         *
         * function limitMe() {
         *   mutex.lock((unlock) => {
         *     asyncFn().then(unlock);
         *   });
         * }
         *
         * limitMe();
         * limitMe(); // <-- will wait for first call to finish & unlock
         *
         */
        var Mutex = (function() {
          function Mutex() {
            _classCallCheck(this, Mutex);

            this._queue = [];
            this.locked = false;
          }

          _createClass(Mutex, [
            {
              key: "lock",
              value: function lock(fn) {
                var _this = this;

                var unlock = function unlock() {
                  var nextFn = _this._queue.shift();

                  if (nextFn) nextFn(unlock);
                  else _this.locked = false;
                };

                if (!this.locked) {
                  this.locked = true;
                  fn(unlock);
                } else {
                  this._queue.push(fn);
                }
              }
            }
          ]);

          return Mutex;
        })();

        module.exports = Mutex;
      },
      {}
    ],
    9: [
      function(require, module, exports) {
        (function(__filename) {
          "use strict";

          function _toConsumableArray(arr) {
            if (Array.isArray(arr)) {
              for (var i = 0, arr2 = Array(arr.length); i < arr.length; i++) {
                arr2[i] = arr[i];
              }
              return arr2;
            } else {
              return Array.from(arr);
            }
          }

          var os = require("os");
          var dgram = require("dgram-browserify");

          var Packet = require("./Packet");

          var EventEmitter = require("./EventEmitter");
          var ExpiringRecordCollection = require("./ExpiringRecordCollection");
          var Mutex = require("./Mutex");
          var misc = require("./misc");
          var hex = require("./hex");

          var filename = require("path").basename(__filename);
          var debug = require("./debug")("dnssd:" + filename);

          var MDNS_PORT = 5353;
          var MDNS_ADDRESS = { IPv4: "224.0.0.251", IPv6: "FF02::FB" };

          /**
           * IP should be considered as internal when:
           * ::1 - IPv6  loopback
           * fc00::/8
           * fd00::/8
           * fe80::/8
           * 10.0.0.0    -> 10.255.255.255  (10/8 prefix)
           * 127.0.0.0   -> 127.255.255.255 (127/8 prefix)
           * 172.16.0.0  -> 172.31.255.255  (172.16/12 prefix)
           * 192.168.0.0 -> 192.168.255.255 (192.168/16 prefix)
           *
           */
          function isLocal(ip) {
            // IPv6
            if (!!~ip.indexOf(":")) {
              return (
                /^::1$/.test(ip) ||
                /^fe80/i.test(ip) ||
                /^fc[0-9a-f]{2}/i.test(ip) ||
                /^fd[0-9a-f]{2}/i.test(ip)
              );
            }

            // IPv4
            var parts = ip.split(".").map(function(n) {
              return parseInt(n, 10);
            });

            return (
              parts[0] === 10 ||
              (parts[0] === 192 && parts[1] === 168) ||
              (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31)
            );
          }

          function isIPv4(ip) {
            return /(?:[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$)/.test(ip);
          }

          function findInterfaceName(address) {
            var interfaces = os.networkInterfaces();

            return Object.keys(interfaces).find(function(name) {
              return interfaces[name].some(function(addr) {
                return addr.address === address;
              });
            });
          }

          /**
           * Maps interface names to a previously created NetworkInterfaces
           */
          var activeInterfaces = {};

          /**
           * Creates a new NetworkInterface
           * @class
           * @extends EventEmitter
           *
           * @param {string} name
           */
          function NetworkInterface(name, address) {
            this._id = name || "INADDR_ANY";
            this._multicastAddr = address;

            debug("Creating new NetworkInterface on `%s`", this._id);
            EventEmitter.call(this);

            // socket binding
            this._usingMe = 0;
            this._isBound = false;
            this._sockets = [];
            this._mutex = new Mutex();

            // incoming / outgoing records
            this.cache = new ExpiringRecordCollection(
              [],
              this._id + "'s cache"
            );
            this._history = new ExpiringRecordCollection(
              [],
              this._id + "'s history"
            );

            // outgoing packet buffers (debugging)
            this._buffers = [];
          }

          NetworkInterface.prototype = Object.create(EventEmitter.prototype);
          NetworkInterface.prototype.constructor = NetworkInterface;

          /**
           * Creates/returns NetworkInterfaces from a name or address of interface.
           * Active interfaces get reused.
           *
           * @static
           *
           * Ex:
           * > const interfaces = NetworkInterface.get('eth0');
           * > const interfaces = NetworkInterface.get('111.222.333.444');
           *
           * @param  {string} arg
           * @return {NetworkInterface}
           */
          NetworkInterface.get = function get() {
            var specific =
              arguments.length > 0 && arguments[0] !== undefined
                ? arguments[0]
                : "";

            // doesn't set a specific multicast send address
            if (!specific) {
              if (!activeInterfaces.any) {
                activeInterfaces.any = new NetworkInterface();
              }

              return activeInterfaces.any;
            }

            // sets multicast send address
            var name = void 0;
            var address = void 0;

            // arg is an IP address
            if (isIPv4(specific)) {
              name = findInterfaceName(specific);
              address = specific;
              // arg is the name of an interface
            } else {
              if (!os.networkInterfaces()[specific]) {
                throw new Error(
                  "Can't find an interface named '" + specific + "'"
                );
              }

              name = specific;
              address = os.networkInterfaces()[name].find(function(a) {
                return a.family === "IPv4";
              }).address;
            }

            if (!name || !address) {
              throw new Error(
                "Interface matching '" + specific + "' not found"
              );
            }

            if (!activeInterfaces[name]) {
              activeInterfaces[name] = new NetworkInterface(name, address);
            }

            return activeInterfaces[name];
          };

          /**
           * Returns the name of the loopback interface (if there is one)
           * @static
           */
          NetworkInterface.getLoopback = function getLoopback() {
            var interfaces = os.networkInterfaces();

            return Object.keys(interfaces).find(function(name) {
              var addresses = interfaces[name];
              return addresses.every(function(address) {
                return address.internal;
              });
            });
          };

          /**
           * Binds each address the interface uses to the multicast address/port
           * Increments `this._usingMe` to keep track of how many browsers/advertisements
           * are using it.
           */
          NetworkInterface.prototype.bind = function() {
            var _this = this;

            return new Promise(function(resolve, reject) {
              _this._usingMe++;

              // prevent concurrent binds:
              _this._mutex.lock(function(unlock) {
                if (_this._isBound) {
                  unlock();
                  resolve();
                  return;
                }

                // create & bind socket
                _this
                  ._bindSocket()
                  .then(function() {
                    debug("Interface " + _this._id + " now bound");
                    _this._isBound = true;
                    unlock();
                    resolve();
                  })
                  .catch(function(err) {
                    _this._usingMe--;
                    reject(err);
                    unlock();
                  });
              });
            });
          };

          NetworkInterface.prototype._bindSocket = function() {
            var _this2 = this;

            var isPending = true;

            var promise = new Promise(function(resolve, reject) {
              var socket = dgram.createSocket({
                type: "udp4",
                reuseAddr: true
              });

              socket.on("error", function(err) {
                if (isPending) reject(err);
                else _this2._onError(err);
              });

              socket.on("close", function() {
                _this2._onError(new Error("Socket closed unexpectedly"));
              });

              socket.on("message", function(msg, rinfo) {
                _this2._onMessage(msg, rinfo);
              });

              socket.on("listening", function() {
                var _ref;

                var sinfo = socket.address();
                debug(
                  _this2._id +
                    " listening on " +
                    sinfo.address +
                    ":" +
                    sinfo.port
                );

                // Make sure loopback is set to ensure we can communicate with any other
                // responders on the same machine. IP_MULTICAST_LOOP might default to
                // true so this may be redundant on some platforms.
                socket.setMulticastLoopback(true);
                socket.setTTL(255);

                // set a specific multicast interface to use for outgoing packets
                if (_this2._multicastAddr)
                  socket.setMulticastInterface(_this2._multicastAddr);

                // add membership on each unique IPv4 interface address
                var addresses = (_ref = []).concat
                  .apply(
                    _ref,
                    _toConsumableArray(Object.values(os.networkInterfaces()))
                  )
                  .filter(function(addr) {
                    return addr.family === "IPv4";
                  })
                  .map(function(addr) {
                    return addr.address;
                  });

                []
                  .concat(_toConsumableArray(new Set(addresses)))
                  .forEach(function(address) {
                    try {
                      socket.addMembership(MDNS_ADDRESS.IPv4, address);
                    } catch (e) {
                      console.log(
                        "OUCH! - could not add membership to interface " +
                          address,
                        e
                      );
                    }
                  });

                _this2._sockets.push(socket);
                resolve();
              });

              socket.bind({ address: "0.0.0.0", port: MDNS_PORT });
            });

            return promise.then(function() {
              isPending = false;
            });
          };

          /**
           * Handles incoming messages.
           *
           * @emtis 'answer' w/ answer packet
           * @emtis 'probe' w/ probe packet
           * @emtis 'query' w/ query packet
           *
           * @param  {Buffer} msg
           * @param  {object} origin
           */
          NetworkInterface.prototype._onMessage = function(msg, origin) {
            if (debug.verbose.isEnabled) {
              debug.verbose(
                "Incoming message on interface %s from %s:%s \n\n%s\n\n",
                this._id,
                origin.address,
                origin.port,
                hex.view(msg)
              );
            }

            var packet = new Packet(msg, origin);

            if (debug.isEnabled) {
              var index = this._buffers.findIndex(function(buf) {
                return msg.equals(buf);
              });
              var address = origin.address,
                port = origin.port;

              if (index !== -1) {
                this._buffers.splice(index, 1); // remove buf @index
                debug(
                  address +
                    ":" +
                    port +
                    " -> " +
                    this._id +
                    " *** Ours: \n\n<-- " +
                    packet +
                    "\n\n"
                );
              } else {
                debug(
                  address +
                    ":" +
                    port +
                    " -> " +
                    this._id +
                    " \n\n<-- " +
                    packet +
                    "\n\n"
                );
              }
            }

            if (!packet.isValid()) return debug("Bad packet, ignoring");

            // must silently ignore responses where source UDP port is not 5353
            if (packet.isAnswer() && origin.port === 5353) {
              this._addToCache(packet);
              this.emit("answer", packet);
            }

            if (packet.isProbe() && origin.port === 5353) {
              this.emit("probe", packet);
            }

            if (packet.isQuery()) {
              this.emit("query", packet);
            }
          };

          /**
           * Adds records from incoming packet to interface cache. Also flushes records
           * (sets them to expire in 1s) if the cache flush bit is set.
           */
          NetworkInterface.prototype._addToCache = function(packet) {
            var _this3 = this;

            debug("Adding records to interface (%s) cache", this._id);

            var incomingRecords = [].concat(
              _toConsumableArray(packet.answers),
              _toConsumableArray(packet.additionals)
            );

            incomingRecords.forEach(function(record) {
              if (record.isUnique) _this3.cache.flushRelated(record);
              _this3.cache.add(record);
            });
          };

          NetworkInterface.prototype.hasRecentlySent = function(record) {
            var range =
              arguments.length > 1 && arguments[1] !== undefined
                ? arguments[1]
                : 1;

            return this._history.hasAddedWithin(record, range);
          };

          /**
           * Send the packet on each socket for this interface.
           * If no unicast destination address/port is given the packet is sent to the
           * multicast address/port.
           */
          NetworkInterface.prototype.send = function(
            packet,
            destination,
            callback
          ) {
            var _this4 = this;

            if (!this._isBound) {
              debug("Interface not bound yet, can't send");
              return callback && callback();
            }

            if (packet.isEmpty()) {
              debug("Packet is empty, not sending");
              return callback && callback();
            }

            if (destination && !isLocal(destination.address)) {
              debug(
                "Destination " +
                  destination.address +
                  " not link-local, not sending"
              );
              return callback && callback();
            }

            if (packet.isAnswer() && !destination) {
              debug.verbose("Adding outgoing multicast records to history");
              this._history.addEach(
                [].concat(
                  _toConsumableArray(packet.answers),
                  _toConsumableArray(packet.additionals)
                )
              );
            }

            var done = callback && misc.after_n(callback, this._sockets.length);
            var buf = packet.toBuffer();

            // send packet on each socket
            this._sockets.forEach(function(socket) {
              var family = socket.address().family;
              var port = destination ? destination.port : MDNS_PORT;
              var address = destination
                ? destination.address
                : MDNS_ADDRESS[family];

              // don't try to send to IPv4 on an IPv6 & vice versa
              if (
                (destination && family === "IPv4" && !isIPv4(address)) ||
                (destination && family === "IPv6" && isIPv4(address))
              ) {
                debug(
                  "Mismatched sockets, (" +
                    family +
                    " to " +
                    destination.address +
                    "), skipping"
                );
                return;
              }

              // the outgoing list _should_ only have a few at any given time
              // but just in case, make sure it doesn't grow indefinitely
              if (debug.isEnabled && _this4._buffers.length < 10)
                _this4._buffers.push(buf);

              debug(
                "%s (%s) -> %s:%s\n\n--> %s\n\n",
                _this4._id,
                family,
                address,
                port,
                packet
              );

              socket.send(buf, 0, buf.length, port, address, function(err) {
                if (!err) return done && done();

                // any other error goes to the handler:
                if (err.code !== "EMSGSIZE") return _this4._onError(err);

                // split big packets up and resend:
                debug("Packet too big to send, splitting");

                packet.split().forEach(function(half) {
                  _this4.send(half, destination, callback);
                });
              });
            });
          };

          /**
           * Browsers/Advertisements use this instead of using stop()
           */
          NetworkInterface.prototype.stopUsing = function() {
            this._usingMe--;
            if (this._usingMe <= 0) this.stop();
          };

          NetworkInterface.prototype.stop = function() {
            debug("Shutting down " + this._id + "...");

            this._sockets.forEach(function(socket) {
              socket.removeAllListeners(); // do first to prevent close events
              try {
                socket.close();
              } catch (e) {
                /**/
              }
            });

            this.cache.clear();
            this._history.clear();

            this._usingMe = 0;
            this._isBound = false;
            this._sockets = [];
            this._buffers = [];

            debug("Done.");
          };

          NetworkInterface.prototype._onError = function(err) {
            debug(this._id + " had an error: " + err + "\n" + err.stack);

            this.stop();
            this.emit("error", err);
          };

          module.exports = NetworkInterface;
        }.call(this, "/../dnssd.js/lib/NetworkInterface.js"));
      },
      {
        "./EventEmitter": 6,
        "./ExpiringRecordCollection": 7,
        "./Mutex": 8,
        "./Packet": 10,
        "./debug": 24,
        "./hex": 26,
        "./misc": 27,
        "dgram-browserify": 31,
        os: 39,
        path: 40
      }
    ],
    10: [
      function(require, module, exports) {
        (function(__filename) {
          "use strict";

          var _slicedToArray = (function() {
            function sliceIterator(arr, i) {
              var _arr = [];
              var _n = true;
              var _d = false;
              var _e = undefined;
              try {
                for (
                  var _i = arr[Symbol.iterator](), _s;
                  !(_n = (_s = _i.next()).done);
                  _n = true
                ) {
                  _arr.push(_s.value);
                  if (i && _arr.length === i) break;
                }
              } catch (err) {
                _d = true;
                _e = err;
              } finally {
                try {
                  if (!_n && _i["return"]) _i["return"]();
                } finally {
                  if (_d) throw _e;
                }
              }
              return _arr;
            }
            return function(arr, i) {
              if (Array.isArray(arr)) {
                return arr;
              } else if (Symbol.iterator in Object(arr)) {
                return sliceIterator(arr, i);
              } else {
                throw new TypeError(
                  "Invalid attempt to destructure non-iterable instance"
                );
              }
            };
          })();

          var _createClass = (function() {
            function defineProperties(target, props) {
              for (var i = 0; i < props.length; i++) {
                var descriptor = props[i];
                descriptor.enumerable = descriptor.enumerable || false;
                descriptor.configurable = true;
                if ("value" in descriptor) descriptor.writable = true;
                Object.defineProperty(target, descriptor.key, descriptor);
              }
            }
            return function(Constructor, protoProps, staticProps) {
              if (protoProps)
                defineProperties(Constructor.prototype, protoProps);
              if (staticProps) defineProperties(Constructor, staticProps);
              return Constructor;
            };
          })();

          function _toConsumableArray(arr) {
            if (Array.isArray(arr)) {
              for (var i = 0, arr2 = Array(arr.length); i < arr.length; i++) {
                arr2[i] = arr[i];
              }
              return arr2;
            } else {
              return Array.from(arr);
            }
          }

          function _classCallCheck(instance, Constructor) {
            if (!(instance instanceof Constructor)) {
              throw new TypeError("Cannot call a class as a function");
            }
          }

          var os = require("os");
          var util = require("util");

          var misc = require("./misc");
          var QueryRecord = require("./QueryRecord");
          var ResourceRecord = require("./ResourceRecord");
          var BufferWrapper = require("./BufferWrapper");
          var RecordCollection = require("./RecordCollection");

          var filename = require("path").basename(__filename);
          var debug = require("./debug")("dnssd:" + filename);

          /**
           * mDNS Packet
           * @class
           *
           * Make new empty packets with `new Packet()`
           * or parse a packet from a buffer with `new Packet(buffer)`
           *
           * Check if there were problems parsing a buffer by checking `packet.isValid()`
           * isValid() will return false if buffer parsing failed or if something is wrong
           * with the packet's header.
           *
           */

          var Packet = (function() {
            /**
             * @param  {Buffer} [buffer] - optional buffer to parse
             * @param  {Object} [origin] - optional msg info
             */
            function Packet(buffer) {
              var origin =
                arguments.length > 1 && arguments[1] !== undefined
                  ? arguments[1]
                  : {};

              _classCallCheck(this, Packet);

              this.header = {
                ID: 0,
                QR: 0,
                OPCODE: 0,
                AA: 0,
                TC: 0,
                RD: 0,
                RA: 0,
                Z: 0,
                AD: 0,
                CD: 0,
                RCODE: 0,
                QDCount: 0,
                ANCount: 0,
                NSCount: 0,
                ARCount: 0
              };

              this.questions = [];
              this.answers = [];
              this.authorities = [];
              this.additionals = [];

              this.origin = {
                address: origin.address,
                port: origin.port
              };

              // wrap parse in try/catch because it could throw
              // if it does, make packet.isValid() always return false
              if (buffer) {
                try {
                  this.parseBuffer(buffer);
                } catch (err) {
                  debug("Packet parse error: " + err + " \n" + err.stack);
                  this.isValid = function() {
                    return false;
                  };
                }
              }
            }

            _createClass(Packet, [
              {
                key: "parseBuffer",
                value: function parseBuffer(buffer) {
                  var wrapper = new BufferWrapper(buffer);

                  var readQuestion = function readQuestion() {
                    return QueryRecord.fromBuffer(wrapper);
                  };
                  var readRecord = function readRecord() {
                    return ResourceRecord.fromBuffer(wrapper);
                  };

                  this.header = this.parseHeader(wrapper);

                  this.questions = misc.map_n(
                    readQuestion,
                    this.header.QDCount
                  );
                  this.answers = misc.map_n(readRecord, this.header.ANCount);
                  this.authorities = misc.map_n(
                    readRecord,
                    this.header.NSCount
                  );
                  this.additionals = misc.map_n(
                    readRecord,
                    this.header.ARCount
                  );
                }

                /**
                 * Header:
                 * +----+----+----+----+----+----+----+----+----+----+----+----+----+----+----+----+
                 * | 1  | 2  | 3  | 4  | 5  | 6  | 7  | 8  | 9  | 10 | 11 | 12 | 13 | 14 | 15 | 16 |
                 * +----+----+----+----+----+----+----+----+----+----+----+----+----+----+----+----+
                 * |                                 Identifier                                    |
                 * +----+-------------------+----+----+----+----+----+----+----+-------------------+
                 * | QR |      OPCODE       | AA | TC | RD | RA | Z  | AD | CD |       RCODE       |
                 * +----+-------------------+----+----+----+----+----+----+----+-------------------+
                 * |                        QDCount (Number of questions)                          |
                 * +-------------------------------------------------------------------------------+
                 * |                      ANCount (Number of answer records)                       |
                 * +-------------------------------------------------------------------------------+
                 * |                     NSCount (Number of authority records)                     |
                 * +-------------------------------------------------------------------------------+
                 * |                    ARCount (Number of additional records)                     |
                 * +-------------------------------------------------------------------------------+
                 *
                 * For mDNS, RD, RA, Z, AD and CD MUST be zero on transmission, and MUST be ignored
                 * on reception. Responses with OPCODEs or RCODEs =/= 0 should be silently ignored.
                 */
              },
              {
                key: "parseHeader",
                value: function parseHeader(wrapper) {
                  var header = {};

                  header.ID = wrapper.readUInt16BE();
                  var flags = wrapper.readUInt16BE();

                  header.QR = (flags & (1 << 15)) >> 15;
                  header.OPCODE = (flags & (0xf << 11)) >> 11;
                  header.AA = (flags & (1 << 10)) >> 10;
                  header.TC = (flags & (1 << 9)) >> 9;
                  header.RD = 0;
                  header.RA = 0;
                  header.Z = 0;
                  header.AD = 0;
                  header.CD = 0;
                  header.RCODE = flags & 0xf;

                  header.QDCount = wrapper.readUInt16BE();
                  header.ANCount = wrapper.readUInt16BE();
                  header.NSCount = wrapper.readUInt16BE();
                  header.ARCount = wrapper.readUInt16BE();

                  return header;
                }
              },
              {
                key: "toBuffer",
                value: function toBuffer() {
                  var wrapper = new BufferWrapper();
                  var writeRecord = function writeRecord(record) {
                    return record.writeTo(wrapper);
                  };

                  this.writeHeader(wrapper);

                  this.questions.forEach(writeRecord);
                  this.answers.forEach(writeRecord);
                  this.authorities.forEach(writeRecord);
                  this.additionals.forEach(writeRecord);

                  return wrapper.unwrap();
                }
              },
              {
                key: "writeHeader",
                value: function writeHeader(wrapper) {
                  var flags =
                    0 +
                    (this.header.QR << 15) +
                    (this.header.OPCODE << 11) +
                    (this.header.AA << 10) +
                    (this.header.TC << 9) +
                    (this.header.RD << 8) +
                    (this.header.RA << 7) +
                    (this.header.Z << 6) +
                    (this.header.AD << 5) +
                    (this.header.CD << 4) +
                    this.header.RCODE;

                  wrapper.writeUInt16BE(this.header.ID);
                  wrapper.writeUInt16BE(flags);

                  wrapper.writeUInt16BE(this.questions.length); // QDCount
                  wrapper.writeUInt16BE(this.answers.length); // ANCount
                  wrapper.writeUInt16BE(this.authorities.length); // NSCount
                  wrapper.writeUInt16BE(this.additionals.length); // ARCount
                }
              },
              {
                key: "setQuestions",
                value: function setQuestions(questions) {
                  this.questions = questions;
                  this.header.QDCount = this.questions.length;
                }
              },
              {
                key: "setAnswers",
                value: function setAnswers(answers) {
                  this.answers = answers;
                  this.header.ANCount = this.answers.length;
                }
              },
              {
                key: "setAuthorities",
                value: function setAuthorities(authorities) {
                  this.authorities = authorities;
                  this.header.NSCount = this.authorities.length;
                }
              },
              {
                key: "setAdditionals",
                value: function setAdditionals(additionals) {
                  this.additionals = additionals;
                  this.header.ARCount = this.additionals.length;
                }
              },
              {
                key: "setResponseBit",
                value: function setResponseBit() {
                  this.header.QR = 1; // response
                  this.header.AA = 1; // authoritative (all responses must be)
                }
              },
              {
                key: "isValid",
                value: function isValid() {
                  return (
                    this.header.OPCODE === 0 &&
                    this.header.RCODE === 0 &&
                    (!this.isAnswer() || this.header.AA === 1)
                  ); // must be authoritative
                }
              },
              {
                key: "isEmpty",
                value: function isEmpty() {
                  return this.isAnswer()
                    ? !this.answers.length // responses have to have answers
                    : !this.questions.length; // queries/probes have to have questions
                }
              },
              {
                key: "isLegacy",
                value: function isLegacy() {
                  return !!this.origin.port && this.origin.port !== 5353;
                }
              },
              {
                key: "isLocal",
                value: function isLocal() {
                  var _ref,
                    _this = this;

                  return (
                    !!this.origin.address &&
                    (_ref = []).concat
                      .apply(
                        _ref,
                        _toConsumableArray(
                          Object.values(os.networkInterfaces())
                        )
                      )
                      .some(function(_ref2) {
                        var address = _ref2.address;
                        return address === _this.origin.address;
                      })
                  );
                }
              },
              {
                key: "isProbe",
                value: function isProbe() {
                  return !!(!this.header.QR && this.authorities.length);
                }
              },
              {
                key: "isQuery",
                value: function isQuery() {
                  return !!(!this.header.QR && !this.authorities.length);
                }
              },
              {
                key: "isAnswer",
                value: function isAnswer() {
                  return !!this.header.QR;
                }
              },
              {
                key: "equals",
                value: function equals(other) {
                  return (
                    misc.equals(this.header, other.header) &&
                    new RecordCollection(this.questions).equals(
                      other.questions
                    ) &&
                    new RecordCollection(this.answers).equals(other.answers) &&
                    new RecordCollection(this.additionals).equals(
                      other.additionals
                    ) &&
                    new RecordCollection(this.authorities).equals(
                      other.authorities
                    )
                  );
                }
              },
              {
                key: "split",
                value: function split() {
                  var one = new Packet();
                  var two = new Packet();

                  one.header = Object.assign({}, this.header);
                  two.header = Object.assign({}, this.header);

                  if (this.isQuery()) {
                    one.header.TC = 1;

                    one.setQuestions(this.questions);
                    two.setQuestions([]);

                    one.setAnswers(
                      this.answers.slice(0, Math.ceil(this.answers.length / 2))
                    );
                    two.setAnswers(
                      this.answers.slice(Math.ceil(this.answers.length / 2))
                    );
                  }

                  if (this.isAnswer()) {
                    var _ref3, _ref4;

                    one.setAnswers(
                      this.answers.slice(0, Math.ceil(this.answers.length / 2))
                    );
                    two.setAnswers(
                      this.answers.slice(Math.ceil(this.answers.length / 2))
                    );

                    one.setAdditionals(
                      (_ref3 = []).concat.apply(
                        _ref3,
                        _toConsumableArray(
                          one.answers.map(function(a) {
                            return a.additionals;
                          })
                        )
                      )
                    );
                    two.setAdditionals(
                      (_ref4 = []).concat.apply(
                        _ref4,
                        _toConsumableArray(
                          two.answers.map(function(a) {
                            return a.additionals;
                          })
                        )
                      )
                    );
                  }

                  // if it can't split packet, just return empties and hope for the best...
                  return [one, two];
                }

                /**
                 * Makes a nice string for looking at packets. Makes something like:
                 *
                 * ANSWER
                 * ├─┬ Questions[2]
                 * │ └── record.local. ANY  QM
                 * ├─┬ Answer RRs[1]
                 * │ └── record.local. A ...
                 * ├─┬ Authority RRs[1]
                 * │ └── record.local. A ...
                 * └─┬ Additional RRs[1]
                 *   └── record.local. A ...
                 */
              },
              {
                key: "toString",
                value: function toString() {
                  var str = "";

                  if (this.isAnswer())
                    str += misc.bg(" ANSWER ", "blue", true) + "\n";
                  if (this.isProbe())
                    str += misc.bg(" PROBE ", "magenta", true) + "\n";
                  if (this.isQuery())
                    str += misc.bg(" QUERY ", "yellow", true) + "\n";

                  var recordGroups = [];
                  var aligned = misc.alignRecords(
                    this.questions,
                    this.answers,
                    this.authorities,
                    this.additionals
                  );

                  if (this.questions.length)
                    recordGroups.push(["Questions", aligned[0]]);
                  if (this.answers.length)
                    recordGroups.push(["Answer RRs", aligned[1]]);
                  if (this.authorities.length)
                    recordGroups.push(["Authority RRs", aligned[2]]);
                  if (this.additionals.length)
                    recordGroups.push(["Additional RRs", aligned[3]]);

                  recordGroups.forEach(function(_ref5, i) {
                    var _ref6 = _slicedToArray(_ref5, 2),
                      name = _ref6[0],
                      records = _ref6[1];

                    var isLastSection = i === recordGroups.length - 1;

                    // add record group header
                    str += util.format(
                      "    %s─┬ %s [%s]\n",
                      isLastSection ? "└" : "├",
                      name,
                      records.length
                    );

                    // add record strings
                    records.forEach(function(record, j) {
                      var isLastRecord = j === records.length - 1;

                      str += util.format(
                        "    %s %s── %s\n",
                        isLastSection ? " " : "│",
                        isLastRecord ? "└" : "├",
                        record
                      );
                    });
                  });

                  return str;
                }
              }
            ]);

            return Packet;
          })();

          module.exports = Packet;
        }.call(this, "/../dnssd.js/lib/Packet.js"));
      },
      {
        "./BufferWrapper": 4,
        "./QueryRecord": 13,
        "./RecordCollection": 14,
        "./ResourceRecord": 15,
        "./debug": 24,
        "./misc": 27,
        os: 39,
        path: 40,
        util: 45
      }
    ],
    11: [
      function(require, module, exports) {
        (function(__filename) {
          "use strict";

          var _slicedToArray = (function() {
            function sliceIterator(arr, i) {
              var _arr = [];
              var _n = true;
              var _d = false;
              var _e = undefined;
              try {
                for (
                  var _i = arr[Symbol.iterator](), _s;
                  !(_n = (_s = _i.next()).done);
                  _n = true
                ) {
                  _arr.push(_s.value);
                  if (i && _arr.length === i) break;
                }
              } catch (err) {
                _d = true;
                _e = err;
              } finally {
                try {
                  if (!_n && _i["return"]) _i["return"]();
                } finally {
                  if (_d) throw _e;
                }
              }
              return _arr;
            }
            return function(arr, i) {
              if (Array.isArray(arr)) {
                return arr;
              } else if (Symbol.iterator in Object(arr)) {
                return sliceIterator(arr, i);
              } else {
                throw new TypeError(
                  "Invalid attempt to destructure non-iterable instance"
                );
              }
            };
          })();

          function _toConsumableArray(arr) {
            if (Array.isArray(arr)) {
              for (var i = 0, arr2 = Array(arr.length); i < arr.length; i++) {
                arr2[i] = arr[i];
              }
              return arr2;
            } else {
              return Array.from(arr);
            }
          }

          var Packet = require("./Packet");
          var QueryRecord = require("./QueryRecord");
          var EventEmitter = require("./EventEmitter");
          var RecordCollection = require("./RecordCollection");
          var TimerContainer = require("./TimerContainer");
          var sleep = require("./sleep");
          var misc = require("./misc");

          var filename = require("path").basename(__filename);
          var debug = require("./debug")("dnssd:" + filename);

          var counter = 0;
          var uniqueId = function uniqueId() {
            return "id#" + ++counter;
          };

          /**
           * Creates a new Probe
           * @class
           * @extends EventEmitter
           *
           * A probe will check if records are unique on a given interface. If they are
           * unique, the probe succeeds and the record name can be used. If any records
           * are found to be not unique, the probe fails and the records need to be
           * renamed.
           *
           * Probes send 3 probe packets out, 250ms apart. If no conflicting answers are
           * received after all 3 have been sent the probe is considered successful.
           *
           * @emits 'complete'
           * @emits 'conflict'
           *
           * @param {NetworkInterface} intf - the interface the probe will work on
           * @param {EventEmitter}     offswitch - emitter used to shut this probe down
           */
          function Probe(intf, offswitch) {
            EventEmitter.call(this);

            // id only used for figuring out logs
            this._id = uniqueId();
            debug("Creating new probe (" + this._id + ")");

            this._interface = intf;
            this._offswitch = offswitch;
            this._questions = new RecordCollection();
            this._authorities = new RecordCollection();
            this._bridgeable = new RecordCollection();

            this._isStopped = false;
            this._numProbesSent = 0;
            this._timers = new TimerContainer(this);

            // listen on answers/probes to check for conflicts
            // stop on either the offswitch or an interface error
            intf
              .using(this)
              .on("answer", this._onAnswer)
              .on("probe", this._onProbe)
              .on("error", this.stop);

            offswitch.using(this).once("stop", this.stop);

            // restart probing process if it was interrupted by sleep
            sleep.using(this).on("wake", this.stop);
          }

          Probe.prototype = Object.create(EventEmitter.prototype);
          Probe.prototype.constructor = Probe;

          /**
           * Add unique records to be probed
           * @param {ResourceRecords|ResourceRecords[]} args
           */
          Probe.prototype.add = function(args) {
            var _this = this;

            var records = Array.isArray(args) ? args : [args];

            records.forEach(function(record) {
              _this._authorities.add(record);
              _this._questions.add(new QueryRecord({ name: record.name }));
            });

            return this;
          };

          /**
           * Sets the record set getting probed across all interfaces, not just this one.
           * Membership in the set helps let us know if a record is getting bridged from
           * one interface to another.
           */
          Probe.prototype.bridgeable = function(bridgeable) {
            this._bridgeable = new RecordCollection(bridgeable);
            return this;
          };

          /**
           * Starts probing records.
           * The first probe should be delayed 0-250ms to prevent collisions.
           */
          Probe.prototype.start = function() {
            if (this._isStopped) return;

            this._timers.setLazy("next-probe", this._send, misc.random(0, 250));
            return this;
          };

          /**
           * Stops the probe. Has to remove any timers that might exist because of this
           * probe, like the next queued timer.
           */
          Probe.prototype.stop = function() {
            if (this._isStopped) return;

            debug("Probe stopped (" + this._id + ")");
            this._isStopped = true;
            this._timers.clear();

            this._interface.removeListenersCreatedBy(this);
            this._offswitch.removeListenersCreatedBy(this);
            sleep.removeListenersCreatedBy(this);
          };

          /**
           * Restarts the probing process
           */
          Probe.prototype._restart = function() {
            this._numProbesSent = 0;
            this._timers.clear();
            this._send();
          };

          /**
           * Sends the probe packets. Gets called repeatedly.
           */
          Probe.prototype._send = function() {
            var _this2 = this;

            var packet = this._makePacket();

            this._numProbesSent++;
            debug(
              "Sending probe #" + this._numProbesSent + "/3 (" + this._id + ")"
            );

            this._interface.send(packet);

            // Queue next action
            // - if 3 probes have been sent, 750ms with no conflicts, probing is complete
            // - otherwise queue next outgoing probe
            this._timers.setLazy(
              "next-probe",
              function() {
                _this2._numProbesSent === 3
                  ? _this2._complete()
                  : _this2._send();
              },
              250
            );
          };

          /**
           * Gets called when the probe completes successfully. If the probe finished
           * early without having to send all 3 probes, completeEarly is set to true.
           *
           * @emits 'complete' with true/false
           *
           * @param {boolean} [completedEarly]
           */
          Probe.prototype._complete = function(completedEarly) {
            debug(
              "Probe (" + this._id + ") complete, early: " + !!completedEarly
            );

            this.stop();
            this.emit("complete", completedEarly);
          };

          /**
           * Create probe packets. Probe packets are the same as query packets but they
           * have records in the authority section.
           */
          Probe.prototype._makePacket = function() {
            var packet = new Packet();

            packet.setQuestions(this._questions.toArray());
            packet.setAuthorities(this._authorities.toArray());

            return packet;
          };

          /**
           * Handles incoming answer packets from other mDNS responders
           *
           * Any answer that conflicts with one of the proposed records causes a conflict
           * and stops the probe. If the answer packet matches all proposed records exactly,
           * it means someone else has already probed the record set and the probe can
           * finish early.
           *
           * Biggest issue here is A/AAAA answer records from bonjour getting bridged.
           *
           * Note: don't need to worry about *our* bridged interface answers here. Probes
           * within a single responder are synchronized and the responder will not
           * transition into a 'responding' state until all the probes are done.
           *
           * @emits 'conflict' when there is a conflict
           *
           * @param {Packet} packet - the incoming answer packet
           */
          Probe.prototype._onAnswer = function(packet) {
            if (this._isStopped) return;

            var incoming = new RecordCollection(
              [].concat(
                _toConsumableArray(packet.answers),
                _toConsumableArray(packet.additionals)
              )
            );

            // if incoming records match the probes records exactly, including rdata,
            // then the record set has already been probed and verified by someone else
            if (incoming.hasEach(this._authorities)) {
              debug(
                "All probe records found in answer, completing early (" +
                  this._id +
                  ")"
              );
              return this._complete(true);
            }

            // check each of our proposed records
            // check if any of the incoming records conflict with the current record
            // check each for a conflict but ignore if we think the record was
            // bridged from another interface (if the record set has the record on
            // some other interface, the packet was probably bridged)

            var conflicts = this._authorities.getConflicts(incoming);
            var hasConflict =
              conflicts.length && !this._bridgeable.hasEach(conflicts);

            // a conflicting response from an authoritative responder is fatal and means
            // the record set needs to be renamed
            if (hasConflict) {
              debug("Found conflict on incoming records (" + this._id + ")");
              this.stop();
              this.emit("conflict");
            }
          };

          /**
           * Handles incoming probe packets
           *
           * Checks for conflicts with simultaneous probes (a rare race condition). If
           * the two probes have conflicting data for the same record set, they are
           * compared and the losing probe has to wait 1 second and try again.
           * (See: 8.2.1. Simultaneous Probe Tiebreaking for Multiple Records)
           *
           * Note: this handle will receive this probe's packets too
           *
           * @param {Packet} packet - the incoming probe packet
           */
          Probe.prototype._onProbe = function(packet) {
            var _this3 = this;

            if (this._isStopped) return;
            debug("Checking probe for conflicts (" + this._id + ")");

            // Prevent probe from choking on cooperating probe packets in the event that
            // they get bridged over another interface. (Eg: AAAA record from interface 1
            // shouldn't conflict with a bridged AAAA record from interface 2, even though
            // the interfaces have different addresses.) Just ignore simultaneous probes
            // from the same machine and not deal with it.
            if (packet.isLocal()) {
              return debug("Local probe, ignoring (" + this._id + ")");
            }

            // Prep records:
            // - split into groups by record name
            // - uppercase name so they can be compared case-insensitively
            // - sort record array by ascending rrtype
            //
            // {
            //  'NAME1': [records],
            //  'NAME2': [records]
            // }
            var local = {};
            var incoming = {};

            var has = function has(obj, prop) {
              return Object.prototype.hasOwnProperty.call(obj, prop);
            };

            this._authorities.toArray().forEach(function(r) {
              var key = r.name.toUpperCase();

              if (has(local, key)) local[key].push(r);
              else local[key] = [r];
            });

            packet.authorities.forEach(function(r) {
              var key = r.name.toUpperCase();

              // only include those that appear in the other group
              if (has(local, key)) {
                if (has(incoming, key)) incoming[key].push(r);
                else incoming[key] = [r];
              }
            });

            Object.keys(local).forEach(function(key) {
              local[key] = local[key].sort(function(a, b) {
                return a.rrtype - b.rrtype;
              });
            });

            Object.keys(incoming).forEach(function(key) {
              incoming[key] = incoming[key].sort(function(a, b) {
                return a.rrtype - b.rrtype;
              });
            });

            // Look for conflicts in each group of records. IE, if there are records
            // named 'A' and records named 'B', look at each set.  'A' records first,
            // and then 'B' records. Stops at the first conflict.
            var hasConflict = Object.keys(local).some(function(name) {
              if (!incoming[name]) return false;

              return _this3._recordsHaveConflict(local[name], incoming[name]);
            });

            // If this probe is found to be in conflict it has to pause for 1 second
            // before trying again. A legitimate competing probe should have completed
            // by then and can then authoritatively respond to this probe, causing this
            // one to fail.
            if (hasConflict) {
              this._timers.clear();
              this._timers.setLazy("restart", this._restart, 1000);
            }
          };

          /**
           * Compares two records sets lexicographically
           *
           * Records are compared, pairwise, in their sorted order, until a difference
           * is found or until one of the lists runs out. If no differences are found,
           * and record lists are the same length, then there is no conflict.
           *
           * Returns true if there was a conflict with this probe's records and false
           * if this probe is ok.
           *
           * @param  {ResourceRecords[]} records
           * @param  {ResourceRecords[]} incomingRecords
           * @return {Boolean}
           */
          Probe.prototype._recordsHaveConflict = function(
            records,
            incomingRecords
          ) {
            debug("Checking for lexicographic conflicts with other probe:");

            var hasConflict = false;
            var pairs = [];

            for (
              var i = 0;
              i < Math.max(records.length, incomingRecords.length);
              i++
            ) {
              pairs.push([records[i], incomingRecords[i]]);
            }

            pairs.forEach(function(_ref) {
              var _ref2 = _slicedToArray(_ref, 2),
                record = _ref2[0],
                incoming = _ref2[1];

              debug("Comparing: %s", record);
              debug("     with: %s", incoming);

              // this probe has LESS records than other probe, this probe LOST
              if (typeof record === "undefined") {
                hasConflict = true;
                return false; // stop comparing
              }

              // this probe has MORE records than other probe, this probe WON
              if (typeof incoming === "undefined") {
                hasConflict = false;
                return false; // stop comparing
              }

              var comparison = record.compare(incoming);

              // record is lexicographically earlier than incoming, this probe LOST
              if (comparison === -1) {
                hasConflict = true;
                return false; // stop comparing
              }

              // record is lexicographically later than incoming, this probe WON
              if (comparison === 1) {
                hasConflict = false;
                return false; // stop comparing
              }

              // otherwise, if records are lexicographically equal, continue and
              // check the next record pair
            });

            debug(
              "Lexicographic conflict %s",
              hasConflict ? "found" : "not found"
            );

            return hasConflict;
          };

          module.exports = Probe;
        }.call(this, "/../dnssd.js/lib/Probe.js"));
      },
      {
        "./EventEmitter": 6,
        "./Packet": 10,
        "./QueryRecord": 13,
        "./RecordCollection": 14,
        "./TimerContainer": 21,
        "./debug": 24,
        "./misc": 27,
        "./sleep": 29,
        path: 40
      }
    ],
    12: [
      function(require, module, exports) {
        (function(__filename) {
          "use strict";

          function _toConsumableArray(arr) {
            if (Array.isArray(arr)) {
              for (var i = 0, arr2 = Array(arr.length); i < arr.length; i++) {
                arr2[i] = arr[i];
              }
              return arr2;
            } else {
              return Array.from(arr);
            }
          }

          var EventEmitter = require("./EventEmitter");
          var RecordCollection = require("./RecordCollection");
          var ExpiringRecordCollection = require("./ExpiringRecordCollection");
          var TimerContainer = require("./TimerContainer");
          var Packet = require("./Packet");
          var QueryRecord = require("./QueryRecord");
          var sleep = require("./sleep");
          var misc = require("./misc");

          var filename = require("path").basename(__filename);
          var debug = require("./debug")("dnssd:" + filename);

          var ONE_SECOND = 1000;
          var ONE_HOUR = 60 * 60 * 1000;

          var counter = 0;
          var uniqueId = function uniqueId() {
            return "id#" + ++counter;
          };

          /**
           * Creates a new Query
           * @class
           * @extends EventEmitter
           *
           * A query asks for records on a given interface. Queries can be continuous
           * or non-continuous. Continuous queries will keep asking for records until it
           * gets them all. Non-continuous queries will stop after the first answer packet
           * it receives, whether or not that packet has answers to its questions.
           *
           * @emits 'answer'
           * @emits 'timeout'
           *
           * @param {NetworkInterface} intf - the interface the query will work on
           * @param {EventEmitter}     offswitch - emitter used to shut this query down
           */
          function Query(intf, offswitch) {
            EventEmitter.call(this);

            // id only used for figuring out logs
            this._id = uniqueId();
            debug("Creating a new query (" + this._id + ")");

            this._intf = intf;
            this._offswitch = offswitch;
            this._originals = [];
            this._questions = new RecordCollection();
            this._knownAnswers = new ExpiringRecordCollection(
              [],
              "Query " + this._id
            );
            this._isStopped = false;

            // defaults
            this._delay = misc.random(20, 120);
            this._ignoreCache = false;
            this._isContinuous = true;
            this._timeoutDelay = null;

            // repeated queries increasing by a factor of 2, starting at 1s apart
            this._next = ONE_SECOND;
            this._queuedPacket = null;
            this._timers = new TimerContainer(this);

            // stop on either the offswitch or an interface error
            intf.using(this).once("error", this.stop);
            offswitch.using(this).once("stop", this.stop);

            // remove expired records from known answer list
            intf.cache.using(this).on("expired", this._removeKnownAnswer);

            // restart query (reset delay, etc) after waking from sleep
            sleep.using(this).on("wake", this._restart);
          }

          Query.prototype = Object.create(EventEmitter.prototype);
          Query.prototype.constructor = Query;

          Query.prototype.setTimeout = function(timeout) {
            this._timeoutDelay = timeout;
            return this;
          };

          Query.prototype.continuous = function(bool) {
            this._isContinuous = !!bool;
            return this;
          };

          Query.prototype.ignoreCache = function(bool) {
            this._ignoreCache = !!bool;
            return this;
          };

          /**
           * Adds questions to the query, record names/types that need an answer
           *
           * {
           *   name: 'Record Name.whatever.local.',
           *   qtype: 33
           * }
           *
           * If qtype isn't given, the QueryRecord that gets made will default to 255/ANY
           * Accepts one question object or many
           *
           * @param {object|object[]} args
           */
          Query.prototype.add = function(args) {
            var _this = this;

            var questions = Array.isArray(args) ? args : [args];
            this._originals = [].concat(_toConsumableArray(questions));

            questions.forEach(function(question) {
              _this._questions.add(new QueryRecord(question));
            });

            return this;
          };

          /**
           * Starts querying for stuff on the interface. Only should be started
           * after all questions have been added.
           */
          Query.prototype.start = function() {
            var _this2 = this;

            // Check the interface's cache for answers before making a network trip
            if (!this._ignoreCache) this._checkCache();

            // If all of the query's questions have been answered via the cache, and no
            // subsequent answers are needed, stop early.
            if (!this._questions.size) {
              debug(
                "All answers found in cache, ending early (" + this._id + ")"
              );
              this.stop();

              return this;
            }

            // Only attach interface listeners now that all questions have been added and
            // the query has been started. Answers shouldn't be processed before the
            // query has been fully set up and started.
            this._intf
              .using(this)
              .on("answer", this._onAnswer)
              .on("query", this._onQuery);

            // Prepare packet early to allow for duplicate question suppression
            this._queuedPacket = this._makePacket();

            // Only start timeout check AFTER initial delay. Otherwise it could possibly
            // timeout before the query has even been sent.
            this._timers.setLazy(
              "next-query",
              function() {
                if (_this2._timeoutDelay) _this2._startTimer();
                _this2._send();
              },
              this._delay
            );

            return this;
          };

          /**
           * Stops the query. Has to remove any timers that might exist because of this
           * query, like this query's timeout, next queued timers, and also any timers
           * inside knownAnswers (ExpiringRecordCollections have timers too).
           */
          Query.prototype.stop = function() {
            if (this._isStopped) return;

            debug("Query stopped (" + this._id + ")");
            this._isStopped = true;

            this._timers.clear();
            this._knownAnswers.clear();

            this._intf.removeListenersCreatedBy(this);
            this._offswitch.removeListenersCreatedBy(this);
            this._intf.cache.removeListenersCreatedBy(this);
            sleep.removeListenersCreatedBy(this);
          };

          /**
           * Resets the query. When waking from sleep the query should clear any known
           * answers and start asking for things again.
           */
          Query.prototype._restart = function() {
            var _this3 = this;

            if (this._isStopped) return;

            debug("Just woke up, restarting query (" + this._id + ")");

            this._timers.clear();
            this._questions.clear();
            this._knownAnswers.clear();

            this._originals.forEach(function(question) {
              _this3._questions.add(new QueryRecord(question));
            });

            this._next = ONE_SECOND;
            this._send();
          };

          /**
           * Sends the query packet. Gets called repeatedly.
           *
           * Each packet is prepared in advance for the next scheduled sending. This way
           * if another query comes in from another mDNS responder with some of the same
           * questions as this query, those questions can be removed from this packet
           * before it gets sent to reduce network chatter.
           *
           * Right before the packet actually gets sent here, any known answers learned
           * from other responders (including those since the last outgoing query) are
           * added to the packet.
           */
          Query.prototype._send = function() {
            debug("Sending query (" + this._id + ")");

            // add known answers (with adjusted TTLs) to the outgoing packet
            var packet = this._addKnownAnswers(this._queuedPacket);

            if (!packet.isEmpty()) this._intf.send(packet);
            else
              debug(
                "No questions to send, suppressing empty packet (" +
                  this._id +
                  ")"
              );

            // queue next. the packet is prepared in advance for duplicate question checks
            if (this._isContinuous) {
              this._queuedPacket = this._makePacket();
              this._timers.setLazy("next-query", this._send, this._next);

              // each successive query doubles the delay up to one hour
              this._next = Math.min(this._next * 2, ONE_HOUR);
            }
          };

          /**
           * Create query packet
           *
           * Note this doesn't add known answers. Those need to be added later as they
           * can change in the time between creating the packet and sending it.
           */
          Query.prototype._makePacket = function() {
            var packet = new Packet();
            packet.setQuestions(this._questions.toArray());

            return packet;
          };

          /**
           * Adds current known answers to the packet
           *
           * Known answers are shared records from other responders. They expire from
           * the known answer list as they get too old. Known answers are usually
           * (always?) shared records for questions that have multiple possible answers,
           * like PTRs.
           */
          Query.prototype._addKnownAnswers = function(packet) {
            // only known answers whose TTL is >50% of the original should be included
            var knownAnswers = this._knownAnswers.getAboveTTL(0.5);

            // the cache-flush bit should not be set on records in known answer lists
            knownAnswers.forEach(function(answer) {
              answer.isUnique = false;
            });

            packet.setAnswers(knownAnswers);

            return packet;
          };

          /**
           * Old records should be removed from the known answer list as they expire
           */
          Query.prototype._removeKnownAnswer = function(record) {
            if (this._knownAnswers.has(record)) {
              debug(
                "Removing expired record from query's known answer list (%s): \n%s",
                this._id,
                record
              );

              this._knownAnswers.delete(record);
            }
          };

          /**
           * Handles incoming answer packets from other mDNS responders
           *
           * If the incoming packet answers all remaining questions or if this query is
           * a 'non-continuous' query, the handler will stop the query and shut it down.
           *
           * @emits 'answer' event with
           *   - each answer record found, and
           *   - all the other records in the packet
           *
           * @param {packet} packet - the incoming packet
           */
          Query.prototype._onAnswer = function(packet) {
            var _this4 = this;

            if (this._isStopped) return;

            var incomingRecords = [].concat(
              _toConsumableArray(packet.answers),
              _toConsumableArray(packet.additionals)
            );

            incomingRecords.forEach(function(record) {
              _this4._questions.forEach(function(question) {
                if (!record.canAnswer(question)) return;
                debug(
                  "Answer found in response (Query %s): \n%s",
                  _this4._id,
                  record
                );

                // If the answer is unique (meaning there is only one answer), don't need
                // to keep asking for it and the question can be removed from the pool.
                // If answer is a shared record (meaning there are possibly more than one
                // answer, like with PTR records), add it to the known answer list.
                if (record.isUnique) _this4._questions.delete(question);
                else _this4._knownAnswers.add(record);

                // emit answer record along with the other record that came with it
                _this4.emit(
                  "answer",
                  record,
                  incomingRecords.filter(function(r) {
                    return r !== record;
                  })
                );
              });
            });

            // Non-continuous queries get shut down after first response, answers or not.
            // Queries that have had all questions answered get shut down now too.
            if (!this._isContinuous || !this._questions.size) this.stop();
          };

          /**
           * Handles incoming queries from other responders
           *
           * This is solely used to do duplicate question suppression (7.3). If another
           * responder has asked the same question as one this query is about to send,
           * this query can suppress that question since someone already asked for it.
           *
           * Only modifies the next scheduled query packet (this._queuedPacket).
           *
           * @param {Packet} packet - the incoming query packet
           */
          Query.prototype._onQuery = function(packet) {
            if (this._isStopped) return;

            // Make sure we don't suppress ourselves by acting on our own
            // packets getting fed back to us. (this handler will receive this query's
            // outgoing packets too as they come back in on the interface.)
            if (packet.isLocal()) return;

            // can only suppress if the known answer section is empty (see 7.3)
            if (packet.answers.length) return;

            // ignore suppression check on QU questions, only applies to QM questions
            var incoming = packet.questions.filter(function(q) {
              return q.QU === false;
            });
            var outgoing = this._queuedPacket.questions.filter(function(q) {
              return q.QU === false;
            });

            // suppress outgoing questions that also appear in incoming records
            var questions = new RecordCollection(outgoing)
              .difference(incoming)
              .toArray();
            var suppressed = outgoing.filter(function(out) {
              return !~questions.indexOf(out);
            });

            if (suppressed.length) {
              debug(
                "Suppressing duplicate questions (%s): %r",
                this._id,
                suppressed
              );
              this._queuedPacket.setQuestions(questions);
            }
          };

          /**
           * Check the interface's cache for valid answers to query's questions
           */
          Query.prototype._checkCache = function() {
            var _this5 = this;

            this._questions.forEach(function(question) {
              var answers = _this5._intf.cache.find(question);

              answers.forEach(function(record) {
                debug(
                  "Answer found in cache (Query %s): \n%s",
                  _this5._id,
                  record
                );

                if (record.isUnique) _this5._questions.delete(question);
                else _this5._knownAnswers.add(record);

                _this5.emit(
                  "answer",
                  record,
                  answers.filter(function(a) {
                    return a !== record;
                  })
                );
              });
            });
          };

          /**
           * Starts the optional timeout timer
           * @emits `timeout` if answers don't arrive in time
           */
          Query.prototype._startTimer = function() {
            var _this6 = this;

            this._timers.set(
              "timeout",
              function() {
                debug("Query timeout (" + _this6._id + ")");

                _this6.emit("timeout");
                _this6.stop();
              },
              this._timeoutDelay
            );
          };

          module.exports = Query;
        }.call(this, "/../dnssd.js/lib/Query.js"));
      },
      {
        "./EventEmitter": 6,
        "./ExpiringRecordCollection": 7,
        "./Packet": 10,
        "./QueryRecord": 13,
        "./RecordCollection": 14,
        "./TimerContainer": 21,
        "./debug": 24,
        "./misc": 27,
        "./sleep": 29,
        path: 40
      }
    ],
    13: [
      function(require, module, exports) {
        "use strict";

        var _createClass = (function() {
          function defineProperties(target, props) {
            for (var i = 0; i < props.length; i++) {
              var descriptor = props[i];
              descriptor.enumerable = descriptor.enumerable || false;
              descriptor.configurable = true;
              if ("value" in descriptor) descriptor.writable = true;
              Object.defineProperty(target, descriptor.key, descriptor);
            }
          }
          return function(Constructor, protoProps, staticProps) {
            if (protoProps) defineProperties(Constructor.prototype, protoProps);
            if (staticProps) defineProperties(Constructor, staticProps);
            return Constructor;
          };
        })();

        function _classCallCheck(instance, Constructor) {
          if (!(instance instanceof Constructor)) {
            throw new TypeError("Cannot call a class as a function");
          }
        }

        var misc = require("./misc");
        var hash = require("./hash");

        var RClass = require("./constants").RClass;
        var RType = require("./constants").RType;
        var RNums = require("./constants").RNums;

        /**
         * Create/parse query records
         * @class
         *
         * Create a new QueryRecord:
         * > const record = new QueryRecord({name: 'Target.local.'});
         *
         * Parse a QueryRecord from a buffer (a wrapped buffer):
         * > const record = QueryRecord.fromBuffer(wrapper);
         *
         */

        var QueryRecord = (function() {
          function QueryRecord(fields) {
            _classCallCheck(this, QueryRecord);

            this.name = fields.name;
            this.qtype = fields.qtype || RType.ANY;
            this.qclass = fields.qclass || RClass.IN;
            this.QU = fields.QU || false;

            // for comparing queries and answers:
            this.hash = hash(this.name, this.qtype, this.qclass);
            this.namehash = this.hash;
          }

          /**
           * @param  {BufferWrapper} wrapper
           * @return {QueryRecord}
           */

          _createClass(
            QueryRecord,
            [
              {
                key: "writeTo",

                /**
                 * @param {BufferWrapper} wrapper
                 */
                value: function writeTo(wrapper) {
                  // flip top bit of qclass to indicate a QU question
                  var classField = this.QU ? this.qclass | 0x8000 : this.qclass;

                  wrapper.writeFQDN(this.name);
                  wrapper.writeUInt16BE(this.qtype);
                  wrapper.writeUInt16BE(classField);
                }

                /**
                 * Check if a query recrod is the exact same as this one (ANY doesn't count)
                 */
              },
              {
                key: "equals",
                value: function equals(queryRecord) {
                  return this.hash === queryRecord.hash;
                }

                /**
                 * Breaks up the record into an array of parts. Used in misc.alignRecords
                 * so stuff can get printed nicely in columns. Only ever used in debugging.
                 */
              },
              {
                key: "toParts",
                value: function toParts() {
                  var type = RNums[this.qtype] || this.qtype;

                  return [
                    this.name,
                    misc.color(type, "blue"),
                    this.QU ? misc.color("QU", "yellow") : "QM"
                  ];
                }
              },
              {
                key: "toString",
                value: function toString() {
                  return this.toParts().join(" ");
                }
              }
            ],
            [
              {
                key: "fromBuffer",
                value: function fromBuffer(wrapper) {
                  var fields = {};
                  fields.name = wrapper.readFQDN();
                  fields.qtype = wrapper.readUInt16BE();

                  // top bit of rrclass field reused as QU/QM bit
                  var classBit = wrapper.readUInt16BE();
                  fields.qclass = classBit & ~0x8000;
                  fields.QU = !!(classBit & 0x8000);

                  return new QueryRecord(fields);
                }
              }
            ]
          );

          return QueryRecord;
        })();

        module.exports = QueryRecord;
      },
      { "./constants": 22, "./hash": 25, "./misc": 27 }
    ],
    14: [
      function(require, module, exports) {
        "use strict";

        var _createClass = (function() {
          function defineProperties(target, props) {
            for (var i = 0; i < props.length; i++) {
              var descriptor = props[i];
              descriptor.enumerable = descriptor.enumerable || false;
              descriptor.configurable = true;
              if ("value" in descriptor) descriptor.writable = true;
              Object.defineProperty(target, descriptor.key, descriptor);
            }
          }
          return function(Constructor, protoProps, staticProps) {
            if (protoProps) defineProperties(Constructor.prototype, protoProps);
            if (staticProps) defineProperties(Constructor, staticProps);
            return Constructor;
          };
        })();

        function _classCallCheck(instance, Constructor) {
          if (!(instance instanceof Constructor)) {
            throw new TypeError("Cannot call a class as a function");
          }
        }

        /**
         * Creates a new RecordCollection
         * @class
         *
         * RecordSet might have been a better name, but a 'record set' has a specific
         * meaning with dns.
         *
         * The 'hash' property of ResourceRecords/QueryRecords is used to keep items in
         * the collection/set unique.
         */
        var RecordCollection = (function() {
          /**
           * @param {ResorceRecord[]} [records] - optional starting records
           */
          function RecordCollection(records) {
            _classCallCheck(this, RecordCollection);

            this.size = 0;
            this._records = {};

            if (records) this.addEach(records);
          }

          _createClass(RecordCollection, [
            {
              key: "has",
              value: function has(record) {
                return Object.hasOwnProperty.call(this._records, record.hash);
              }
            },
            {
              key: "hasEach",
              value: function hasEach(records) {
                var _this = this;

                return records.every(function(record) {
                  return _this.has(record);
                });
              }
            },
            {
              key: "hasAny",
              value: function hasAny(records) {
                return !!this.intersection(records).size;
              }

              /**
               * Retrieves the equivalent record from the collection
               *
               * Eg, for two equivalent records A and B:
               *   A !== B                  - different objects
               *   A.equals(B) === true     - but equivalent records
               *
               *   collection.add(A)
               *   collection.get(B) === A  - returns object A, not B
               */
            },
            {
              key: "get",
              value: function get(record) {
                return this.has(record)
                  ? this._records[record.hash]
                  : undefined;
              }
            },
            {
              key: "add",
              value: function add(record) {
                if (!this.has(record)) {
                  this._records[record.hash] = record;
                  this.size++;
                }
              }
            },
            {
              key: "addEach",
              value: function addEach(records) {
                var _this2 = this;

                records.forEach(function(record) {
                  return _this2.add(record);
                });
              }
            },
            {
              key: "delete",
              value: function _delete(record) {
                if (this.has(record)) {
                  delete this._records[record.hash];
                  this.size--;
                }
              }
            },
            {
              key: "clear",
              value: function clear() {
                this._records = {};
                this.size = 0;
              }
            },
            {
              key: "rebuild",
              value: function rebuild() {
                var records = this.toArray();

                this.clear();
                this.addEach(records);
              }
            },
            {
              key: "toArray",
              value: function toArray() {
                return Object.values(this._records);
              }
            },
            {
              key: "forEach",
              value: function forEach(fn, context) {
                this.toArray().forEach(fn.bind(context));
              }

              /**
               * @return {RecordCollection} - a new record collection
               */
            },
            {
              key: "filter",
              value: function filter(fn, context) {
                return new RecordCollection(
                  this.toArray().filter(fn.bind(context))
                );
              }

              /**
               * @return {RecordCollection} - a new record collection
               */
            },
            {
              key: "reject",
              value: function reject(fn, context) {
                return this.filter(function(r) {
                  return !fn.call(context, r);
                });
              }

              /**
               * @return {ResourceRecords[]} - array, not a new record collection
               */
            },
            {
              key: "map",
              value: function map(fn, context) {
                return this.toArray().map(fn.bind(context));
              }
            },
            {
              key: "reduce",
              value: function reduce(fn, acc, context) {
                return this.toArray().reduce(fn.bind(context), acc);
              }
            },
            {
              key: "some",
              value: function some(fn, context) {
                return this.toArray().some(fn.bind(context));
              }
            },
            {
              key: "every",
              value: function every(fn, context) {
                return this.toArray().every(fn.bind(context));
              }

              /**
               * @param  {RecordCollection|ResourceRecords[]} values - array or collection
               * @return {boolean}
               */
            },
            {
              key: "equals",
              value: function equals(values) {
                var otherSet =
                  values instanceof RecordCollection
                    ? values
                    : new RecordCollection(values);

                if (this.size !== otherSet.size) return false;

                return this.every(function(record) {
                  return otherSet.has(record);
                });
              }

              /**
               * Returns a new RecordCollection containing the values of this collection
               * minus the records contained in the other record collection
               *
               * @param  {RecordCollection|ResourceRecords[]} values
               * @return {RecordCollection}
               */
            },
            {
              key: "difference",
              value: function difference(values) {
                var otherSet =
                  values instanceof RecordCollection
                    ? values
                    : new RecordCollection(values);

                return this.reject(function(record) {
                  return otherSet.has(record);
                });
              }

              /**
               * Returns a new RecordCollection containing the values that exist in both
               * this collection and in the other record collection
               *
               * @param  {RecordCollection|ResourceRecords[]} values
               * @return {RecordCollection}
               */
            },
            {
              key: "intersection",
              value: function intersection(values) {
                var otherSet =
                  values instanceof RecordCollection
                    ? values
                    : new RecordCollection(values);

                return this.filter(function(record) {
                  return otherSet.has(record);
                });
              }

              /**
               * Checks if a group of records conflicts in any way with this set.
               * Returns all records that are conflicts out of the given values.
               *
               * Records that occur in both sets are ignored when check for conflicts.
               * This is to deal with a scenario like this:
               *
               * If this set has:
               *   A 'host.local' 1.1.1.1
               *   A 'host.local' 2.2.2.2
               *
               * And incoming set look like:
               *   A 'host.local' 1.1.1.1
               *   A 'host.local' 2.2.2.2
               *   A 'host.local' 3.3.3.3  <------ extra record
               *
               * That extra record shouldn't be a conflict with 1.1.1.1 or 2.2.2.2,
               * its probably bonjour telling us that there's more addresses that
               * can be used that we're not currently using.
               *
               * @param  {RecordCollection|ResourceRecords[]} values
               * @return {ResourceRecords[]}
               */
            },
            {
              key: "getConflicts",
              value: function getConflicts(values) {
                var otherSet =
                  values instanceof RecordCollection
                    ? values
                    : new RecordCollection(values);

                // remove records that aren't conflicts
                var thisSet = this.difference(otherSet);
                otherSet = otherSet.difference(this);

                // find all records from the other set that conflict
                var conflicts = otherSet.filter(function(otherRecord) {
                  return thisSet.some(function(thisRecord) {
                    return thisRecord.conflictsWith(otherRecord);
                  });
                });

                return conflicts.toArray();
              }
            }
          ]);

          return RecordCollection;
        })();

        module.exports = RecordCollection;
      },
      {}
    ],
    15: [
      function(require, module, exports) {
        (function(Buffer, __filename) {
          "use strict";

          var _slicedToArray = (function() {
            function sliceIterator(arr, i) {
              var _arr = [];
              var _n = true;
              var _d = false;
              var _e = undefined;
              try {
                for (
                  var _i = arr[Symbol.iterator](), _s;
                  !(_n = (_s = _i.next()).done);
                  _n = true
                ) {
                  _arr.push(_s.value);
                  if (i && _arr.length === i) break;
                }
              } catch (err) {
                _d = true;
                _e = err;
              } finally {
                try {
                  if (!_n && _i["return"]) _i["return"]();
                } finally {
                  if (_d) throw _e;
                }
              }
              return _arr;
            }
            return function(arr, i) {
              if (Array.isArray(arr)) {
                return arr;
              } else if (Symbol.iterator in Object(arr)) {
                return sliceIterator(arr, i);
              } else {
                throw new TypeError(
                  "Invalid attempt to destructure non-iterable instance"
                );
              }
            };
          })();

          var _createClass = (function() {
            function defineProperties(target, props) {
              for (var i = 0; i < props.length; i++) {
                var descriptor = props[i];
                descriptor.enumerable = descriptor.enumerable || false;
                descriptor.configurable = true;
                if ("value" in descriptor) descriptor.writable = true;
                Object.defineProperty(target, descriptor.key, descriptor);
              }
            }
            return function(Constructor, protoProps, staticProps) {
              if (protoProps)
                defineProperties(Constructor.prototype, protoProps);
              if (staticProps) defineProperties(Constructor, staticProps);
              return Constructor;
            };
          })();

          function _toConsumableArray(arr) {
            if (Array.isArray(arr)) {
              for (var i = 0, arr2 = Array(arr.length); i < arr.length; i++) {
                arr2[i] = arr[i];
              }
              return arr2;
            } else {
              return Array.from(arr);
            }
          }

          function _possibleConstructorReturn(self, call) {
            if (!self) {
              throw new ReferenceError(
                "this hasn't been initialised - super() hasn't been called"
              );
            }
            return call &&
              (typeof call === "object" || typeof call === "function")
              ? call
              : self;
          }

          function _inherits(subClass, superClass) {
            if (typeof superClass !== "function" && superClass !== null) {
              throw new TypeError(
                "Super expression must either be null or a function, not " +
                  typeof superClass
              );
            }
            subClass.prototype = Object.create(
              superClass && superClass.prototype,
              {
                constructor: {
                  value: subClass,
                  enumerable: false,
                  writable: true,
                  configurable: true
                }
              }
            );
            if (superClass)
              Object.setPrototypeOf
                ? Object.setPrototypeOf(subClass, superClass)
                : (subClass.__proto__ = superClass);
          }

          function _classCallCheck(instance, Constructor) {
            if (!(instance instanceof Constructor)) {
              throw new TypeError("Cannot call a class as a function");
            }
          }

          var hash = require("./hash");
          var misc = require("./misc");
          var BufferWrapper = require("./BufferWrapper");

          var filename = require("path").basename(__filename);
          var debug = require("./debug")("dnssd:" + filename);

          var RClass = require("./constants").RClass;
          var RType = require("./constants").RType;
          var RNums = require("./constants").RNums;

          /**
           * Create/parse resource records
           * @class
           *
           * Create a specific ResourceRecord (AAAA):
           * > const record = new ResourceRecord.AAAA({name: 'Target.local.', address: '::1'});
           *
           * Parse a ResourceRecord from a buffer (a wrapped buffer):
           * > const record = ResourceRecord.fromBuffer(wrapper);
           *
           */

          var ResourceRecord = (function() {
            function ResourceRecord(fields) {
              _classCallCheck(this, ResourceRecord);

              if (this.constructor === ResourceRecord)
                throw new Error("Abstract only!");
              if (!fields || !fields.name)
                throw new Error("Record must have a name");

              this.name = fields.name;
              this.rrtype = fields.rrtype || RType[this.constructor.name];
              this.rrclass = fields.rrclass || RClass.IN;

              if ("ttl" in fields) this.ttl = fields.ttl;
              if ("isUnique" in fields) this.isUnique = fields.isUnique;

              this.additionals = fields.additionals || [];
            }

            /**
             * Parse a record from a buffer. Starts reading the wrapped buffer at w/e
             * position its at when fromBuffer is called.
             *
             * @param  {BufferWrapper} wrapper
             * @return {ResourceRecord}
             */

            _createClass(
              ResourceRecord,
              [
                {
                  key: "_makehashes",

                  /**
                   * Makes a couple hashes of record properties so records can get compared
                   * easier.
                   */
                  value: function _makehashes() {
                    // a hash for name/rrtype/rrclass (records like PTRs might share name/type
                    // but have different rdata)
                    this.namehash = hash(this.name, this.rrtype, this.rrclass);
                    // hash for comparing rdata
                    this.rdatahash = this._hashRData();
                    // a unique hash for a given name/type/class *AND* rdata
                    this.hash = hash(this.namehash, this.rdatahash);
                  }

                  /**
                   * Writes the record to a wrapped buffer at the wrapper's current position.
                   * @param {BufferWrapper} wrapper
                   */
                },
                {
                  key: "writeTo",
                  value: function writeTo(wrapper) {
                    var classField = this.isUnique
                      ? this.rrclass | 0x8000
                      : this.rrclass;

                    // record info
                    wrapper.writeFQDN(this.name);
                    wrapper.writeUInt16BE(this.rrtype);
                    wrapper.writeUInt16BE(classField);
                    wrapper.writeUInt32BE(this.ttl);

                    // leave UInt16BE gap to write rdataLen
                    var rdataLenPos = wrapper.tell();
                    wrapper.skip(2);

                    // record specific rdata
                    this._writeRData(wrapper);

                    // go back and add rdata length
                    var rdataLen = wrapper.tell() - rdataLenPos - 2;
                    wrapper.buffer.writeUInt16BE(rdataLen, rdataLenPos);
                  }

                  /**
                   * Checks if this record conflicts with another. Records conflict if they
                   * 1) are both unique (shared record sets can't conflict)
                   * 2) have the same name/type/class
                   * 3) but have different rdata
                   *
                   * @param  {ResourceRecord} record
                   * @return {boolean}
                   */
                },
                {
                  key: "conflictsWith",
                  value: function conflictsWith(record) {
                    var hasConflict =
                      this.isUnique &&
                      record.isUnique &&
                      this.namehash === record.namehash &&
                      this.rdatahash !== record.rdatahash;

                    if (hasConflict) {
                      debug(
                        "Found conflict: \nRecord: %s\nIncoming: %s",
                        this,
                        record
                      );
                    }

                    return hasConflict;
                  }

                  /**
                   * Checks if this record can answer the question. Record names are compared
                   * case insensitively.
                   *
                   * @param  {QueryRecord} question
                   * @return {boolean}
                   */
                },
                {
                  key: "canAnswer",
                  value: function canAnswer(question) {
                    return (
                      (this.rrclass === question.qclass ||
                        question.qclass === RClass.ANY) &&
                      (this.rrtype === question.qtype ||
                        question.qtype === RType.ANY) &&
                      this.name.toUpperCase() === question.name.toUpperCase()
                    );
                  }

                  /**
                   * Records are equal if name/type/class and rdata are the same
                   */
                },
                {
                  key: "equals",
                  value: function equals(record) {
                    return this.hash === record.hash;
                  }

                  /**
                   * Determines which record is lexicographically later. Used to determine
                   * which probe wins when two competing probes are sent at the same time.
                   * (see https://tools.ietf.org/html/rfc6762#section-8.2)
                   *
                   * means comparing, in order,
                   * - rrclass
                   * - rrtype
                   * - rdata, byte by byte
                   *
                   * Rdata has to be written to a buffer first and then compared.
                   * The cache flush bit has to be excluded as well when comparing
                   * rrclass.
                   *
                   *  1 = this record comes later than the other record
                   * -1 = this record comes earlier than the other record
                   *  0 = records are equal
                   *
                   * @param  {ResourceRecord} record
                   * @return {number}
                   */
                },
                {
                  key: "compare",
                  value: function compare(record) {
                    if (this.equals(record)) return 0;

                    if (this.rrclass > record.rrclass) return 1;
                    if (this.rrclass < record.rrclass) return -1;

                    if (this.rrtype > record.rrtype) return 1;
                    if (this.rrtype < record.rrtype) return -1;

                    // make buffers out of em so we can compare byte by byte
                    // this also prevents data from being name compressed, since
                    // we are only writing a single rdata, and nothing else
                    var rdata_1 = new BufferWrapper();
                    var rdata_2 = new BufferWrapper();

                    this._writeRData(rdata_1);
                    record._writeRData(rdata_2);

                    return rdata_1.unwrap().compare(rdata_2.unwrap());
                  }

                  /**
                   * Test if a record matches some properties. String values are compared
                   * case insensitively.
                   *
                   * Ex:
                   * > const isMatch = record.matches({name: 'test.', priority: 12})
                   *
                   * @param  {object} properties
                   * @return {boolean}
                   */
                },
                {
                  key: "matches",
                  value: function matches(properties) {
                    var _this = this;

                    return Object.keys(properties)
                      .map(function(key) {
                        return [key, properties[key]];
                      })
                      .every(function(_ref) {
                        var _ref2 = _slicedToArray(_ref, 2),
                          key = _ref2[0],
                          value = _ref2[1];

                        return typeof _this[key] === "string" &&
                          typeof value === "string"
                          ? _this[key].toUpperCase() === value.toUpperCase()
                          : misc.equals(_this[key], value);
                      });
                  }

                  /**
                   * Returns a clone of the record, making a new object
                   */
                },
                {
                  key: "clone",
                  value: function clone() {
                    var type = this.constructor.name;
                    var fields = this;

                    return new ResourceRecord[type](fields);
                  }

                  /**
                   * If anything changes on a record it needs to be re-hashed. Otherwise
                   * all the comparisons won't work with the new changes.
                   *
                   * Bad:  record.target = 'new.local.';
                   * Good: record.updateWith(() => {record.target = 'new.local.'});
                   *
                   */
                },
                {
                  key: "updateWith",
                  value: function updateWith(fn) {
                    // give record to updater function to modify
                    fn(this);
                    // rehash in case name/rdata changed
                    this._makehashes();
                  }

                  /**
                   * Records with reserved names shouldn't be goodbye'd
                   *
                   * _services._dns-sd._udp.<domain>.
                   *         b._dns-sd._udp.<domain>.
                   *        db._dns-sd._udp.<domain>.
                   *         r._dns-sd._udp.<domain>.
                   *        dr._dns-sd._udp.<domain>.
                   *        lb._dns-sd._udp.<domain>.
                   */
                },
                {
                  key: "canGoodbye",
                  value: function canGoodbye() {
                    var name = this.name.toLowerCase();
                    return name.indexOf("._dns-sd._udp.") === -1;
                  }

                  /**
                   * Breaks up the record into an array of parts. Used in misc.alignRecords
                   * so stuff can get printed nicely in columns. Only ever used in debugging.
                   */
                },
                {
                  key: "toParts",
                  value: function toParts() {
                    var parts = [];

                    var type =
                      this.constructor.name === "Unknown"
                        ? this.rrtype
                        : this.constructor.name;

                    var ttl =
                      this.ttl === 0
                        ? misc.color(this.ttl, "red")
                        : String(this.ttl);

                    parts.push(this.name);
                    parts.push(
                      this.ttl === 0
                        ? misc.color(type, "red")
                        : misc.color(type, "blue")
                    );

                    parts.push(ttl);
                    parts.push(String(this._getRDataStr()));

                    if (this.isUnique)
                      parts.push(misc.color("(flush)", "grey"));

                    return parts;
                  }
                },
                {
                  key: "toString",
                  value: function toString() {
                    return this.toParts().join(" ");
                  }
                }
              ],
              [
                {
                  key: "fromBuffer",
                  value: function fromBuffer(wrapper) {
                    var name = wrapper.readFQDN();
                    var rrtype = wrapper.readUInt16BE();
                    var rrclass = wrapper.readUInt16BE();
                    var ttl = wrapper.readUInt32BE();

                    // top-bit in rrclass is reused as the cache-flush bit
                    var fields = {
                      name: name,
                      rrtype: rrtype,
                      rrclass: rrclass & ~0x8000,
                      isUnique: !!(rrclass & 0x8000),
                      ttl: ttl
                    };

                    if (rrtype === RType.A)
                      return new ResourceRecord.A(fields, wrapper);
                    if (rrtype === RType.PTR)
                      return new ResourceRecord.PTR(fields, wrapper);
                    if (rrtype === RType.TXT)
                      return new ResourceRecord.TXT(fields, wrapper);
                    if (rrtype === RType.AAAA)
                      return new ResourceRecord.AAAA(fields, wrapper);
                    if (rrtype === RType.SRV)
                      return new ResourceRecord.SRV(fields, wrapper);
                    if (rrtype === RType.NSEC)
                      return new ResourceRecord.NSEC(fields, wrapper);

                    return new ResourceRecord.Unknown(fields, wrapper);
                  }
                }
              ]
            );

            return ResourceRecord;
          })();

          /**
           * A record (IPv4 address)
           */

          var A = (function(_ResourceRecord) {
            _inherits(A, _ResourceRecord);

            /**
             * @param  {object} fields
             * @param  {BufferWrapper} [wrapper] - only used by the .fromBuffer method
             */
            function A(fields, wrapper) {
              _classCallCheck(this, A);

              // defaults:
              var _this2 = _possibleConstructorReturn(
                this,
                (A.__proto__ || Object.getPrototypeOf(A)).call(this, fields)
              );

              misc.defaults(_this2, { ttl: 120, isUnique: true });

              // rdata:
              _this2.address = fields.address || "";

              if (wrapper) _this2._readRData(wrapper);
              _this2._makehashes();
              return _this2;
            }

            _createClass(A, [
              {
                key: "_readRData",
                value: function _readRData(wrapper) {
                  var _len = wrapper.readUInt16BE();
                  var n1 = wrapper.readUInt8();
                  var n2 = wrapper.readUInt8();
                  var n3 = wrapper.readUInt8();
                  var n4 = wrapper.readUInt8();

                  this.address = n1 + "." + n2 + "." + n3 + "." + n4;
                }
              },
              {
                key: "_writeRData",
                value: function _writeRData(wrapper) {
                  this.address.split(".").forEach(function(str) {
                    var n = parseInt(str, 10);
                    wrapper.writeUInt8(n);
                  });
                }
              },
              {
                key: "_hashRData",
                value: function _hashRData() {
                  return hash(this.address);
                }
              },
              {
                key: "_getRDataStr",
                value: function _getRDataStr() {
                  return this.address;
                }
              }
            ]);

            return A;
          })(ResourceRecord);

          ResourceRecord.A = A;

          /**
           * PTR record
           */

          var PTR = (function(_ResourceRecord2) {
            _inherits(PTR, _ResourceRecord2);

            function PTR(fields, wrapper) {
              _classCallCheck(this, PTR);

              // defaults:
              var _this3 = _possibleConstructorReturn(
                this,
                (PTR.__proto__ || Object.getPrototypeOf(PTR)).call(this, fields)
              );

              misc.defaults(_this3, { ttl: 4500, isUnique: false });

              // rdata:
              _this3.PTRDName = fields.PTRDName || "";

              if (wrapper) _this3._readRData(wrapper);
              _this3._makehashes();
              return _this3;
            }

            _createClass(PTR, [
              {
                key: "_readRData",
                value: function _readRData(wrapper) {
                  var _len = wrapper.readUInt16BE();
                  this.PTRDName = wrapper.readFQDN();
                }
              },
              {
                key: "_writeRData",
                value: function _writeRData(wrapper) {
                  wrapper.writeFQDN(this.PTRDName);
                }
              },
              {
                key: "_hashRData",
                value: function _hashRData() {
                  return hash(this.PTRDName);
                }
              },
              {
                key: "_getRDataStr",
                value: function _getRDataStr() {
                  return this.PTRDName;
                }
              }
            ]);

            return PTR;
          })(ResourceRecord);

          ResourceRecord.PTR = PTR;

          /**
           * TXT record
           *
           * key/value conventions:
           * - Key present with value
           *   'key=value' -> {key: value}
           *
           * - Key present, _empty_ value:
           *   'key=' -> {key: null}
           *
           * - Key present, but no value:
           *   'key' -> {key: true}
           *
           * Important note: keys are case insensitive
           */

          var TXT = (function(_ResourceRecord3) {
            _inherits(TXT, _ResourceRecord3);

            function TXT(fields, wrapper) {
              _classCallCheck(this, TXT);

              // defaults:
              var _this4 = _possibleConstructorReturn(
                this,
                (TXT.__proto__ || Object.getPrototypeOf(TXT)).call(this, fields)
              );

              misc.defaults(_this4, { ttl: 4500, isUnique: true });

              // rdata:
              _this4.txtRaw = misc.makeRawTXT(fields.txt || {});
              _this4.txt = misc.makeReadableTXT(fields.txt || {});

              if (wrapper) _this4._readRData(wrapper);
              _this4._makehashes();
              return _this4;
            }

            _createClass(TXT, [
              {
                key: "_readRData",
                value: function _readRData(wrapper) {
                  var rdataLength = wrapper.readUInt16BE();
                  var end = wrapper.tell() + rdataLength;
                  var len = void 0;

                  // read each key: value pair
                  while (wrapper.tell() < end && (len = wrapper.readUInt8())) {
                    var key = "";
                    var chr = void 0,
                      value = void 0;

                    while (len-- > 0 && (chr = wrapper.readString(1)) !== "=") {
                      key += chr;
                    }

                    if (len > 0) value = wrapper.read(len);
                    else if (chr === "=") value = null;
                    else value = true;

                    this.txtRaw[key] = value;
                    this.txt[key] = Buffer.isBuffer(value)
                      ? value.toString()
                      : value;
                  }
                }
              },
              {
                key: "_writeRData",
                value: function _writeRData(wrapper) {
                  var _this5 = this;

                  // need to at least put a 0 byte if no txt data
                  if (!Object.keys(this.txtRaw).length) {
                    return wrapper.writeUInt8(0);
                  }

                  // value is either true, null, or a buffer
                  Object.keys(this.txtRaw).forEach(function(key) {
                    var value = _this5.txtRaw[key];
                    var str = value === true ? key : key + "=";
                    var len = Buffer.byteLength(str);

                    if (Buffer.isBuffer(value)) len += value.length;

                    wrapper.writeUInt8(len);
                    wrapper.writeString(str);

                    if (Buffer.isBuffer(value)) wrapper.add(value);
                  });
                }
              },
              {
                key: "_hashRData",
                value: function _hashRData() {
                  return hash(this.txtRaw);
                }
              },
              {
                key: "_getRDataStr",
                value: function _getRDataStr() {
                  return misc.truncate(JSON.stringify(this.txt), 30);
                }
              }
            ]);

            return TXT;
          })(ResourceRecord);

          ResourceRecord.TXT = TXT;

          /**
           * AAAA record (IPv6 address)
           */

          var AAAA = (function(_ResourceRecord4) {
            _inherits(AAAA, _ResourceRecord4);

            function AAAA(fields, wrapper) {
              _classCallCheck(this, AAAA);

              // defaults:
              var _this6 = _possibleConstructorReturn(
                this,
                (AAAA.__proto__ || Object.getPrototypeOf(AAAA)).call(
                  this,
                  fields
                )
              );

              misc.defaults(_this6, { ttl: 120, isUnique: true });

              // rdata:
              _this6.address = fields.address || "";

              if (wrapper) _this6._readRData(wrapper);
              _this6._makehashes();
              return _this6;
            }

            _createClass(AAAA, [
              {
                key: "_readRData",
                value: function _readRData(wrapper) {
                  var _len = wrapper.readUInt16BE();
                  var raw = wrapper.read(16);
                  var parts = [];

                  for (var i = 0; i < raw.length; i += 2) {
                    parts.push(raw.readUInt16BE(i).toString(16));
                  }

                  this.address = parts
                    .join(":")
                    .replace(/(^|:)0(:0)*:0(:|$)/, "$1::$3")
                    .replace(/:{3,4}/, "::");
                }
              },
              {
                key: "_writeRData",
                value: function _writeRData(wrapper) {
                  function expandIPv6(str) {
                    var ip = str;

                    // replace ipv4 address if any
                    var ipv4_match = ip.match(
                      /(.*:)([0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$)/
                    );

                    if (ipv4_match) {
                      ip = ipv4_match[1];
                      var ipv4 = ipv4_match[2].match(/[0-9]+/g);

                      for (var i = 0; i < 4; i++) {
                        ipv4[i] = parseInt(ipv4[i], 10).toString(16);
                      }

                      ip += ipv4[0] + ipv4[1] + ":" + ipv4[2] + ipv4[3];
                    }

                    // take care of leading and trailing ::
                    ip = ip.replace(/^:|:$/g, "");

                    var ipv6 = ip.split(":");

                    for (var _i2 = 0; _i2 < ipv6.length; _i2++) {
                      // normalize grouped zeros ::
                      if (ipv6[_i2] === "") {
                        ipv6[_i2] = new Array(9 - ipv6.length)
                          .fill(0)
                          .join(":");
                      }
                    }

                    return ipv6.join(":");
                  }

                  expandIPv6(this.address)
                    .split(":")
                    .forEach(function(str) {
                      var u16 = parseInt(str, 16);
                      wrapper.writeUInt16BE(u16);
                    });
                }
              },
              {
                key: "_hashRData",
                value: function _hashRData() {
                  return hash(this.address);
                }
              },
              {
                key: "_getRDataStr",
                value: function _getRDataStr() {
                  return this.address;
                }
              }
            ]);

            return AAAA;
          })(ResourceRecord);

          ResourceRecord.AAAA = AAAA;

          /**
           * SRV record
           */

          var SRV = (function(_ResourceRecord5) {
            _inherits(SRV, _ResourceRecord5);

            function SRV(fields, wrapper) {
              _classCallCheck(this, SRV);

              // defaults:
              var _this7 = _possibleConstructorReturn(
                this,
                (SRV.__proto__ || Object.getPrototypeOf(SRV)).call(this, fields)
              );

              misc.defaults(_this7, { ttl: 120, isUnique: true });

              // rdata:
              _this7.target = fields.target || "";
              _this7.port = fields.port || 0;
              _this7.priority = fields.priority || 0;
              _this7.weight = fields.weight || 0;

              if (wrapper) _this7._readRData(wrapper);
              _this7._makehashes();
              return _this7;
            }

            _createClass(SRV, [
              {
                key: "_readRData",
                value: function _readRData(wrapper) {
                  var _len = wrapper.readUInt16BE();
                  this.priority = wrapper.readUInt16BE();
                  this.weight = wrapper.readUInt16BE();
                  this.port = wrapper.readUInt16BE();
                  this.target = wrapper.readFQDN();
                }
              },
              {
                key: "_writeRData",
                value: function _writeRData(wrapper) {
                  wrapper.writeUInt16BE(this.priority);
                  wrapper.writeUInt16BE(this.weight);
                  wrapper.writeUInt16BE(this.port);
                  wrapper.writeFQDN(this.target);
                }
              },
              {
                key: "_hashRData",
                value: function _hashRData() {
                  return hash(
                    this.priority,
                    this.weight,
                    this.port,
                    this.target
                  );
                }
              },
              {
                key: "_getRDataStr",
                value: function _getRDataStr() {
                  return (
                    this.target +
                    " " +
                    this.port +
                    " P:" +
                    this.priority +
                    " W:" +
                    this.weight
                  );
                }
              }
            ]);

            return SRV;
          })(ResourceRecord);

          ResourceRecord.SRV = SRV;

          /**
           * NSEC record
           * Only handles the limited 'restricted' form (record rrtypes < 255)
           */

          var NSEC = (function(_ResourceRecord6) {
            _inherits(NSEC, _ResourceRecord6);

            function NSEC(fields, wrapper) {
              _classCallCheck(this, NSEC);

              // defaults:
              var _this8 = _possibleConstructorReturn(
                this,
                (NSEC.__proto__ || Object.getPrototypeOf(NSEC)).call(
                  this,
                  fields
                )
              );

              misc.defaults(_this8, { ttl: 120, isUnique: true });

              // rdata:
              _this8.existing = (fields.existing || []).sort(function(a, b) {
                return a - b;
              });

              if (wrapper) _this8._readRData(wrapper);
              _this8._makehashes();
              return _this8;
            }

            _createClass(NSEC, [
              {
                key: "_readRData",
                value: function _readRData(wrapper) {
                  var rdataLength = wrapper.readUInt16BE();
                  var rdataEnd = wrapper.tell() + rdataLength;

                  var _name = wrapper.readFQDN(); // doesn't matter, ignored
                  var block = wrapper.readUInt8(); // window block for rrtype bitfield
                  var len = wrapper.readUInt8(); // number of octets in bitfield

                  // Ignore rrtypes over 255 (only implementing the restricted form)
                  // Bitfield length must always be < 32, otherwise skip parsing
                  if (block !== 0 || len > 32) return wrapper.seek(rdataEnd);

                  // NSEC rrtype bitfields can be up to 256 bits (32 bytes), BUT
                  // - js bitwise operators are only do 32 bits
                  // - node's buffer.readIntBE() can only read up to 6 bytes
                  //
                  // So here we're doing 1 byte of the field at a time
                  //
                  for (var maskNum = 0; maskNum < len; maskNum++) {
                    var mask = wrapper.readUInt8(1);
                    if (mask === 0) continue;

                    for (var bit = 0; bit < 8; bit++) {
                      if (mask & (1 << bit)) {
                        // rrtypes in bitfields are in network bit order
                        // 01000000 => 1 === RType.A (bit 6)
                        // 00000000 00000000 00000000 00001000 => 28 === RType.AAAA (bit 3)
                        var rrtype = 8 * maskNum + (7 - bit);
                        this.existing.push(rrtype);
                      }
                    }
                  }
                }
              },
              {
                key: "_writeRData",
                value: function _writeRData(wrapper) {
                  // restricted form, only rrtypes up to 255
                  var rrtypes = []
                    .concat(_toConsumableArray(new Set(this.existing)))
                    .filter(function(x) {
                      return x <= 255;
                    });

                  // Same problems as _readRData, 32 bit operators and can't write big ints,
                  // so bitfields are broken up into 1 byte segments and handled one at a time
                  var len = !rrtypes.length
                    ? 0
                    : Math.ceil(
                        Math.max.apply(Math, _toConsumableArray(rrtypes)) / 8
                      );
                  var masks = Array(len).fill(0);

                  rrtypes.forEach(function(rrtype) {
                    var index = ~~(rrtype / 8); // which mask this rrtype is on
                    var bit = 7 - (rrtype % 8); // convert to network bit order

                    masks[index] |= 1 << bit;
                  });

                  wrapper.writeFQDN(this.name); // "next domain name", ignored for mdns
                  wrapper.writeUInt8(0); // block number, always 0 for restricted form
                  wrapper.writeUInt8(len); // bitfield length in octets

                  // write masks byte by byte since node buffers can only write 42 bit numbers
                  masks.forEach(function(mask) {
                    return wrapper.writeUInt8(mask);
                  });
                }
              },
              {
                key: "_hashRData",
                value: function _hashRData() {
                  return hash(this.existing);
                }
              },
              {
                key: "_getRDataStr",
                value: function _getRDataStr() {
                  return this.existing
                    .map(function(rrtype) {
                      return RNums[rrtype] || rrtype;
                    })
                    .join(", ");
                }
              }
            ]);

            return NSEC;
          })(ResourceRecord);

          ResourceRecord.NSEC = NSEC;

          /**
           * Unknown record, anything not describe above. Could be OPT records, etc.
           */

          var Unknown = (function(_ResourceRecord7) {
            _inherits(Unknown, _ResourceRecord7);

            function Unknown(fields, wrapper) {
              _classCallCheck(this, Unknown);

              // defaults:
              var _this9 = _possibleConstructorReturn(
                this,
                (Unknown.__proto__ || Object.getPrototypeOf(Unknown)).call(
                  this,
                  fields
                )
              );

              misc.defaults(_this9, { ttl: 120, isUnique: true });

              // rdata:
              _this9.rdata = fields.rdata || Buffer.alloc(0);

              if (wrapper) _this9._readRData(wrapper);
              _this9._makehashes();
              return _this9;
            }

            _createClass(Unknown, [
              {
                key: "_readRData",
                value: function _readRData(wrapper) {
                  var rdataLength = wrapper.readUInt16BE();
                  this.RData = wrapper.read(rdataLength);
                }
              },
              {
                key: "_writeRData",
                value: function _writeRData(wrapper) {
                  wrapper.add(this.RData);
                }
              },
              {
                key: "_hashRData",
                value: function _hashRData() {
                  return hash(this.RData);
                }
              },
              {
                key: "_getRDataStr",
                value: function _getRDataStr() {
                  // replace non-ascii characters w/ gray dots
                  function ascii(chr) {
                    return /[ -~]/.test(chr) ? chr : misc.color(".", "grey");
                  }

                  var chars = this.RData.toString().split("");
                  var str = chars
                    .slice(0, 30)
                    .map(ascii)
                    .join("");

                  return chars.length <= 30 ? str : str + "…";
                }
              }
            ]);

            return Unknown;
          })(ResourceRecord);

          ResourceRecord.Unknown = Unknown;

          module.exports = ResourceRecord;
        }.call(
          this,
          require("buffer").Buffer,
          "/../dnssd.js/lib/ResourceRecord.js"
        ));
      },
      {
        "./BufferWrapper": 4,
        "./constants": 22,
        "./debug": 24,
        "./hash": 25,
        "./misc": 27,
        buffer: 36,
        path: 40
      }
    ],
    16: [
      function(require, module, exports) {
        (function(__filename) {
          "use strict";

          var _createClass = (function() {
            function defineProperties(target, props) {
              for (var i = 0; i < props.length; i++) {
                var descriptor = props[i];
                descriptor.enumerable = descriptor.enumerable || false;
                descriptor.configurable = true;
                if ("value" in descriptor) descriptor.writable = true;
                Object.defineProperty(target, descriptor.key, descriptor);
              }
            }
            return function(Constructor, protoProps, staticProps) {
              if (protoProps)
                defineProperties(Constructor.prototype, protoProps);
              if (staticProps) defineProperties(Constructor, staticProps);
              return Constructor;
            };
          })();

          function _toConsumableArray(arr) {
            if (Array.isArray(arr)) {
              for (var i = 0, arr2 = Array(arr.length); i < arr.length; i++) {
                arr2[i] = arr[i];
              }
              return arr2;
            } else {
              return Array.from(arr);
            }
          }

          function _possibleConstructorReturn(self, call) {
            if (!self) {
              throw new ReferenceError(
                "this hasn't been initialised - super() hasn't been called"
              );
            }
            return call &&
              (typeof call === "object" || typeof call === "function")
              ? call
              : self;
          }

          function _inherits(subClass, superClass) {
            if (typeof superClass !== "function" && superClass !== null) {
              throw new TypeError(
                "Super expression must either be null or a function, not " +
                  typeof superClass
              );
            }
            subClass.prototype = Object.create(
              superClass && superClass.prototype,
              {
                constructor: {
                  value: subClass,
                  enumerable: false,
                  writable: true,
                  configurable: true
                }
              }
            );
            if (superClass)
              Object.setPrototypeOf
                ? Object.setPrototypeOf(subClass, superClass)
                : (subClass.__proto__ = superClass);
          }

          function _classCallCheck(instance, Constructor) {
            if (!(instance instanceof Constructor)) {
              throw new TypeError("Cannot call a class as a function");
            }
          }

          var misc = require("./misc");
          var EventEmitter = require("./EventEmitter");
          var RecordCollection = require("./RecordCollection");
          var TimerContainer = require("./TimerContainer");
          var StateMachine = require("./StateMachine");

          var Probe = require("./Probe");
          var Response = require("./Response");

          var filename = require("path").basename(__filename);
          var debug = require("./debug")("dnssd:" + filename);

          var RType = require("./constants").RType;
          var ONE_SECOND = 1000;

          /**
           * Make ids, just to keep track of which responder is which in debug messages
           */
          var counter = 0;
          var uniqueId = function uniqueId() {
            return "id#" + ++counter;
          };

          /**
           * Responders need to keep track of repeated conflicts to save the network. If
           * a responder has more than 15 conflicts in a small window then the responder
           * should be throttled to prevent it from spamming everyone. Conflict count
           * gets cleared after 15s w/o any conflicts
           */

          var ConflictCounter = (function() {
            function ConflictCounter() {
              _classCallCheck(this, ConflictCounter);

              this._count = 0;
              this._timer = null;
            }

            _createClass(ConflictCounter, [
              {
                key: "count",
                value: function count() {
                  return this._count;
                }
              },
              {
                key: "increment",
                value: function increment() {
                  var _this = this;

                  this._count++;
                  clearTimeout(this._timer);

                  // reset conflict counter after 15 seconds
                  this._timer = setTimeout(function() {
                    _this._count = 0;
                  }, 15 * ONE_SECOND);

                  // prevent timer from holding the process
                  this._timer.unref();
                }
              },
              {
                key: "clear",
                value: function clear() {
                  this._count = 0;
                  clearTimeout(this._timer);
                }
              }
            ]);

            return ConflictCounter;
          })();

          /**
           * Responder
           * @class
           *
           * A responder object takes a record set and:
           * - probes to see if anyone else on the network is using that name
           * - responds to queries (and other probes) about the record set
           * - renames the records whenever there is a conflict (from probes/answers)
           * - sends goodbye messages when stopped
           *
           * A record set will be something like A/AAAA address records for interfaces or
           * PTR/SRV/TXT records for a service. Each set will only have one unique name.
           *
           * Responders keeps record set names in sync across any number of interfaces,
           * so if the set has a conflict on any one interface it will cause it to be
           * renamed on all interfaces.
           *
           * Functions as a state machine with these main states:
           * probing -> conflict (rename) -> responding -> goodbying -> stopped (final)
           *
           * Listens to interface probe, answer, and query events. Any errors from
           * interfaces are bad and stops to whole thing.
           *
           * @emits 'probingComplete' when probing has completed successfully
           * @emits 'rename' w/ new name whenever a conflict forces a rename
           * @emits 'error'
           */

          var responderStates = {
            probing: {
              enter: function enter() {
                var _this2 = this;

                debug("Now probing for: " + this._fullname);

                var onSuccess = function onSuccess(early) {
                  _this2.transition("responding", early);
                };
                var onFail = function onFail() {
                  _this2.transition("conflict");
                };

                // If the probing process takes longer than 1 minute something is wrong
                // and it should abort. This gets cleared when entering responding state
                if (!this._timers.has("timeout")) {
                  this._timers.set(
                    "timeout",
                    function() {
                      _this2.transition(
                        "stopped",
                        new Error("Could not probe within 1 min")
                      );
                    },
                    60 * ONE_SECOND
                  );
                }

                // If there are too many sequential conflicts, take a break before probing
                if (this._conflicts.count() >= 15) {
                  debug(
                    "Too many conflicts, slowing probe down. (" + this._id + ")"
                  );

                  this._timers.set(
                    "delayed-probe",
                    function() {
                      _this2._sendProbe(onSuccess, onFail);
                    },
                    5 * ONE_SECOND
                  );

                  return;
                }

                this._sendProbe(onSuccess, onFail);
              },

              // If records get updated mid-probe we need to restart the probing process
              update: function update() {
                this.states.probing.exit.call(this);
                this.states.probing.enter.call(this);
              },

              // Stop any active probes, not needed anymore
              // Stop probes that were being throttled due to repeated conflicts
              exit: function exit() {
                this._stopActives();
                this._timers.clear("delayed-probe");
              }
            },

            responding: {
              enter: function enter(skipAnnounce) {
                debug(
                  'Done probing, now responding for "' +
                    this._fullname +
                    '" (' +
                    this._id +
                    ")"
                );

                // clear probing timeout since probing was successful
                this._timers.clear("timeout");

                // announce verified records to the network (or not)
                if (!skipAnnounce) this._sendAnnouncement(3);
                else debug("Skipping announcement. (" + this._id + ")");

                // emit last
                this.emit("probingComplete");
              },

              // Only listen to these interface events in the responding state:
              probe: function probe(packet) {
                this._onProbe(packet);
              },
              query: function query(packet) {
                this._onQuery(packet);
              },
              answer: function answer(packet) {
                this._onAnswer(packet);
              },

              // stop any active announcements / responses before announcing changes
              update: function update() {
                this._stopActives();
                this._sendAnnouncement();
              },

              // stop any active announcements / responses before changing state
              exit: function exit() {
                this._stopActives();
              }
            },

            // Records get renamed on conflict, nothing else happens, no events fire.
            // Mostly is its own state for the convenience of having other exit &
            // enter handlers called.
            conflict: {
              enter: function enter() {
                debug(
                  'Had a conflict with "' +
                    this._instance +
                    '", renaming. (' +
                    this._id +
                    ")"
                );

                // Instance -> Instance (2)
                var oldName = this._instance;
                var newName = this._rename(oldName);

                // Instance._http._tcp.local. -> Instance (2)._http._tcp.local.
                var oldFull = this._fullname;
                var newFull = this._fullname.replace(oldName, newName);

                this._instance = newName;
                this._fullname = newFull;

                // apply rename to records (using updateWith() so records get rehashed)
                // (note, has to change PTR fields too)
                function rename(record) {
                  record.updateWith(function() {
                    if (record.name === oldFull) record.name = newFull;
                    if (record.PTRDName === oldFull) record.PTRDName = newFull;
                  });
                }

                this._records.forEach(rename);
                this._bridgeable.forEach(rename);

                // rebuild bridge set since renames alters record hashes
                this._bridgeable.rebuild();

                this._conflicts.increment();
                this.transition("probing");

                // emits the new (not yet verified) name
                this.emit("rename", newName);
              }
            },

            // Sends TTL=0 goodbyes for all records. Uses a callback that fires once all
            // goodbyes have been sent. Transitions to stopped when done.
            goodbying: {
              enter: function enter(callback) {
                var _this3 = this;

                var finish = function finish() {
                  _this3.transition("stopped");
                  callback();
                };

                // Only send goodbyes if records were valid/probed, otherwise just stop
                if (this.prevState !== "responding") finish();
                else this._sendGoodbye(finish);
              },
              exit: function exit() {
                this._stopActives();
              }
            },

            // Terminal state. Cleans up any existing timers and stops listening to
            // interfaces. Emits any errors, like from probing timeouts.
            stopped: {
              enter: function enter(err) {
                debug("Responder stopping (" + this._id + ")");

                this._timers.clear();
                this._conflicts.clear();
                this._stopActives();
                this._removeListeners();

                if (err) this.emit("error", err);

                // override this.transition, because responder is stopped now
                // (shouldn't ever be a problem anyway, mostly for debugging)
                this.transition = function() {
                  return debug("Responder is stopped! Can't transition.");
                };
              }
            }
          };

          /**
           * @constructor
           *
           * Records is an array of all records, some may be on one interface, some may
           * be on another interface. (Each record has an .interfaceID field that
           * indicates what interface it should be used on. We need this because some
           * record, like A/AAAA which have different rdata (addresses) for each
           * interface they get used on.) So the records param might look like this:
           * [
           *   'Target.local.' A    192.168.1.10 ethernet,  <-- different rdata
           *   'Target.local.' AAAA FF::CC::1    ethernet,
           *   'Target.local.' NSEC A, AAAA      ethernet,
           *   'Target.local.' A    192.168.1.25 wifi,      <-- different rdata
           *   'Target.local.' AAAA AA::BB::7    wifi,
           *   'Target.local.' NSEC A, AAAA      wifi,      <-- same as ethernet ok
           * ]
           *
           * @param  {NetworkInterfaces} interface
           * @param  {ResourceRecords[]} records
           * @param  {ResourceRecords[]} bridgeable
           */

          var Responder = (function(_StateMachine) {
            _inherits(Responder, _StateMachine);

            function Responder(intf, records, bridgeable) {
              _classCallCheck(this, Responder);

              var _this4 = _possibleConstructorReturn(
                this,
                (Responder.__proto__ || Object.getPrototypeOf(Responder)).call(
                  this,
                  responderStates
                )
              );

              _this4._id = uniqueId();
              debug(
                "Creating new responder (%s) using: %r",
                _this4._id,
                records
              );

              var uniques = [].concat(
                _toConsumableArray(
                  new Set(
                    records
                      .filter(function(r) {
                        return r.isUnique;
                      })
                      .map(function(r) {
                        return r.name;
                      })
                  )
                )
              );

              if (!uniques.length) throw Error("No unique names in record set");
              if (uniques.length > 1)
                throw Error("Too many unique names in record set");

              _this4._interface = intf;
              _this4._records = records;
              _this4._bridgeable = new RecordCollection(bridgeable);

              // the unique name that this record set revolves around
              // eg: "Instance._http._tcp.local."
              _this4._fullname = uniques[0];

              // the part of the name that needs to be renamed on conflicts
              // eg: "Instance"
              _this4._instance = misc.parse(_this4._fullname).instance;
              if (!_this4._instance)
                throw Error("No instance name found in records");

              _this4._timers = new TimerContainer(_this4);
              _this4._conflicts = new ConflictCounter();

              // emitter used to stop child probes & responses without having to hold
              // onto a reference for each one
              _this4._offswitch = new EventEmitter();
              return _this4;
            }

            _createClass(Responder, [
              {
                key: "start",
                value: function start() {
                  debug("Starting responder (" + this._id + ")");
                  this._addListeners();
                  this.transition("probing");
                }

                // Immediately stops the responder (no goodbyes)
              },
              {
                key: "stop",
                value: function stop() {
                  debug("Stopping responder (" + this._id + ")");
                  this.transition("stopped");
                }

                // Sends goodbyes before stopping
              },
              {
                key: "goodbye",
                value: function goodbye(onComplete) {
                  if (this.state === "stopped") {
                    debug("Responder already stopped!");
                    return onComplete();
                  }

                  debug("Goodbying on responder (" + this._id + ")");
                  this.transition("goodbying", onComplete);
                }

                /**
     * Updates all records that match the rrtype.
     *
      // updates should only consist of updated rdata, no name changes
      // (which means no shared records will be changed, and no goodbyes)
      * @param {integer}  rrtype - rrtype to be updated
     * @param {function} fn     - function to call that does the updating
     */
              },
              {
                key: "updateEach",
                value: function updateEach(rrtype, fn) {
                  debug(
                    "Updating rtype " + rrtype + " records. (" + this._id + ")"
                  );

                  // modify properties of each record with given update fn
                  this._records
                    .filter(function(record) {
                      return record.rrtype === rrtype;
                    })
                    .forEach(function(record) {
                      return record.updateWith(fn);
                    });

                  // (update bridge list too)
                  this._bridgeable
                    .filter(function(record) {
                      return record.rrtype === rrtype;
                    })
                    .forEach(function(record) {
                      return record.updateWith(fn);
                    });

                  // rebuild bridge set since updates may have altered record hashes
                  this._bridgeable.rebuild();

                  // may need to announce changes or re-probe depending on current state
                  this.handle("update");
                }

                /**
                 * Get all records being used on an interface
                 * (important because records could change with renaming)
                 * @return {ResourceRecords[]}
                 */
              },
              {
                key: "getRecords",
                value: function getRecords() {
                  return this._records;
                }
              },
              {
                key: "_addListeners",
                value: function _addListeners() {
                  var _this5 = this;

                  this._interface
                    .using(this)
                    .on("probe", function(packet) {
                      return _this5.handle("probe", packet);
                    })
                    .on("query", function(packet) {
                      return _this5.handle("query", packet);
                    })
                    .on("answer", function(packet) {
                      return _this5.handle("answer", packet);
                    })
                    .once("error", function(err) {
                      return _this5.transition("stopped", err);
                    });
                }
              },
              {
                key: "_removeListeners",
                value: function _removeListeners() {
                  this._interface.removeListenersCreatedBy(this);
                }

                /**
                 * Stop any active probes, announcements, or goodbyes (all outgoing stuff uses
                 * the same offswitch)
                 */
              },
              {
                key: "_stopActives",
                value: function _stopActives() {
                  debug("Sending stop signal to actives. (" + this._id + ")");
                  this._offswitch.emit("stop");
                }

                /**
                 * Probes records on each interface, call onSuccess when all probes have
                 * completed successfully or calls onFail as soon as one probes fails. Probes
                 * may finish early in some situations. If they do, onSuccess is called with
                 * `true` to indicate that.
                 */
              },
              {
                key: "_sendProbe",
                value: function _sendProbe(onSuccess, onFail) {
                  var _this6 = this;

                  debug(
                    'Sending probes for "' +
                      this._fullname +
                      '". (' +
                      this._id +
                      ")"
                  );
                  if (this.state === "stopped")
                    return debug("... already stopped!");

                  // only unique records need to be probed
                  var records = this._records.filter(function(record) {
                    return record.isUnique;
                  });

                  // finish early if exact copies are found in the cache
                  if (
                    records.every(function(record) {
                      return _this6._interface.cache.has(record);
                    })
                  ) {
                    debug("All records found in cache, skipping probe...");
                    return onSuccess(true);
                  }

                  // skip network trip if any conflicting records are found in cache
                  if (
                    records.some(function(record) {
                      return _this6._interface.cache.hasConflictWith(record);
                    })
                  ) {
                    debug("Conflict found in cache, renaming...");
                    return onFail();
                  }

                  new Probe(this._interface, this._offswitch)
                    .add(records)
                    .bridgeable(this._bridgeable)
                    .once("conflict", onFail)
                    .once("complete", onSuccess)
                    .start();
                }

                /**
                 * Send unsolicited announcements out when
                 * - done probing
                 * - changing rdata on a verified records (like TXTs)
                 * - defensively correcting issues (TTL=0's, bridged records)
                 */
              },
              {
                key: "_sendAnnouncement",
                value: function _sendAnnouncement() {
                  var num =
                    arguments.length > 0 && arguments[0] !== undefined
                      ? arguments[0]
                      : 1;

                  debug(
                    "Sending " +
                      num +
                      ' announcements for "' +
                      this._fullname +
                      '". (' +
                      this._id +
                      ")"
                  );
                  if (this.state === "stopped")
                    return debug("... already stopped!");

                  new Response.Multicast(this._interface, this._offswitch)
                    .add(this._records)
                    .repeat(num)
                    .start();
                }
              },
              {
                key: "_sendGoodbye",
                value: function _sendGoodbye(onComplete) {
                  debug(
                    'Sending goodbyes for "' +
                      this._fullname +
                      '". (' +
                      this._id +
                      ")"
                  );
                  if (this.state === "stopped")
                    return debug("... already stopped!");

                  // skip goodbyes for special record types, like the enumerator PTR
                  var records = this._records.filter(function(record) {
                    return record.canGoodbye();
                  });

                  new Response.Goodbye(this._interface, this._offswitch)
                    .add(records)
                    .once("stopped", onComplete)
                    .start();
                }

                /**
                 * "Instance" -> "Instance (2)"
                 * "Instance (2)" -> "Instance (3)", etc.
                 */
              },
              {
                key: "_rename",
                value: function _rename(label) {
                  var re = /\((\d+)\)$/; // match ' (#)'

                  function nextSuffix(match, n) {
                    var next = parseInt(n, 10) + 1;
                    return "(" + next + ")";
                  }

                  return re.test(label)
                    ? label.replace(re, nextSuffix)
                    : label + " (2)";
                }

                /**
                 * Handles incoming probes from an interface. Only ever gets used in the
                 * `responding` state. Sends out multicast and/or unicast responses if any of
                 * the probe records conflict with what this responder is currently using.
                 */
              },
              {
                key: "_onProbe",
                value: function _onProbe(packet) {
                  var intf = this._interface;
                  var name = this._fullname;
                  var records = this._records;

                  var multicast = [];
                  var unicast = [];

                  packet.questions.forEach(function(question) {
                    // check if negative responses are needed for this question, ie responder
                    // controls the name but doesn't have rrtype XYZ record. send NSEC instead.
                    var shouldAnswer =
                      question.name.toUpperCase() === name.toUpperCase();
                    var answered = false;

                    records.forEach(function(record) {
                      if (!record.canAnswer(question)) return;

                      // send as unicast if requested BUT only if the interface has not
                      // multicast this record recently (withing 1/4 of the record's TTL)
                      if (
                        question.QU &&
                        intf.hasRecentlySent(record, record.ttl / 4)
                      ) {
                        unicast.push(record);
                        answered = true;
                      } else {
                        multicast.push(record);
                        answered = true;
                      }
                    });

                    if (shouldAnswer && !answered) {
                      multicast.push(
                        records.find(function(r) {
                          return r.rrtype === RType.NSEC && r.name === name;
                        })
                      );
                    }
                  });

                  if (multicast.length) {
                    debug(
                      "Defending name with a multicast response. (" +
                        this._id +
                        ")"
                    );

                    new Response.Multicast(intf, this._offswitch)
                      .defensive(true)
                      .add(multicast)
                      .start();
                  }

                  if (unicast.length) {
                    debug(
                      "Defending name with a unicast response. (" +
                        this._id +
                        ")"
                    );

                    new Response.Unicast(intf, this._offswitch)
                      .respondTo(packet)
                      .defensive(true)
                      .add(unicast)
                      .start();
                  }
                }

                /**
                 * Handles incoming queries from an interface. Only ever gets used in the
                 * `responding` state. Sends out multicast and/or unicast responses if any of
                 * the responders records match the questions.
                 */
              },
              {
                key: "_onQuery",
                value: function _onQuery(packet) {
                  var intf = this._interface;
                  var name = this._fullname;
                  var records = this._records;
                  var knownAnswers = new RecordCollection(packet.answers);

                  var multicast = [];
                  var unicast = [];
                  var suppressed = [];

                  packet.questions.forEach(function(question) {
                    // Check if negative responses are needed for this question, ie responder
                    // controls the name but doesn't have rrtype XYZ record. send NSEC instead.
                    var shouldAnswer =
                      question.name.toUpperCase() === name.toUpperCase();
                    var answered = false;

                    records.forEach(function(record) {
                      if (!record.canAnswer(question)) return;
                      var knownAnswer = knownAnswers.get(record);

                      // suppress known answers if the answer's TTL is still above 50%
                      if (knownAnswer && knownAnswer.ttl > record.ttl / 2) {
                        suppressed.push(record);
                        answered = true;

                        // always respond via unicast to legacy queries (not from port 5353)
                      } else if (packet.isLegacy()) {
                        unicast.push(record);
                        answered = true;

                        // send as unicast if requested BUT only if the interface has not
                        // multicast this record recently (withing 1/4 of the record's TTL)
                      } else if (
                        question.QU &&
                        intf.hasRecentlySent(record, record.ttl / 4)
                      ) {
                        unicast.push(record);
                        answered = true;

                        // otherwise send a multicast response
                      } else {
                        multicast.push(record);
                        answered = true;
                      }
                    });

                    if (shouldAnswer && !answered) {
                      multicast.push(
                        records.find(function(r) {
                          return r.rrtype === RType.NSEC && r.name === name;
                        })
                      );
                    }
                  });

                  if (suppressed.length) {
                    debug(
                      "Suppressing known answers (%s): %r",
                      this._id,
                      suppressed
                    );
                  }

                  if (multicast.length) {
                    debug(
                      "Answering question with a multicast response. (" +
                        this._id +
                        ")"
                    );

                    new Response.Multicast(intf, this._offswitch)
                      .add(multicast)
                      .start();
                  }

                  if (unicast.length) {
                    debug(
                      "Answering question with a unicast response. (" +
                        this._id +
                        ")"
                    );

                    new Response.Unicast(intf, this._offswitch)
                      .respondTo(packet)
                      .add(unicast)
                      .start();
                  }
                }

                /**
                 * Handles incoming answer packets from an interface. Only ever gets used in
                 * the `responding` state, meaning it will also have to handle packets that
                 * originated from the responder itself as they get looped back through the
                 * interfaces.
                 *
                 * The handler watches for:
                 * - Conflicting answers, which would force the responder to re-probe
                 * - Bad goodbyes that need to be fixed / re-announced
                 * - Bridged packets that make the responder re-announce
                 *
                 * Bridged packets need special attention here because they cause problems.
                 * (See: https://tools.ietf.org/html/rfc6762#section-14)
                 *
                 * Scenario: both wifi and ethernet are connected on a machine. This responder
                 * uses A/AAAA records for each interface, but they have different addresses.
                 * Because the interfaces are bridged, wifi packets get heard on ethernet and
                 * vice versa. The responder would normally freak out because the wifi A/AAAA
                 * records conflict with the ethernet A/AAAA records, causing a never ending
                 * spiral of conflicts/probes/death. The solution is to check if records got
                 * bridged before freaking out. The second problem is that the wifi records
                 * will then clobber anything on the ethernet, flushing the ethernet records
                 * from their caches (flush records get deleted in 1s, remember). To correct
                 * this, when we detect our packets getting bridged back to us we need to
                 * re-announce our records. This will restore the records in everyone's caches
                 * and prevent them from getting deleted (that 1s thing). In response to the
                 * re-announced (and bridged) ethernet records, the responder will try to
                 * re-announce the wifi records, but this cycle will be stopped because
                 * records are limited to being sent once ever 1 second. Its kind of a mess.
                 *
                 * Note, we don't need to worry about handling our own goodbye records
                 * because there is no _onAnswer handler in the `goodbying` state.
                 */
              },
              {
                key: "_onAnswer",
                value: function _onAnswer(packet) {
                  var records = new RecordCollection(this._records);
                  var incoming = new RecordCollection(
                    [].concat(
                      _toConsumableArray(packet.answers),
                      _toConsumableArray(packet.additionals)
                    )
                  );

                  // Defensively re-announce records getting TTL=0'd by other responders.
                  var shouldFix = incoming
                    .filter(function(record) {
                      return record.ttl === 0;
                    })
                    .hasAny(records);

                  if (shouldFix) {
                    debug(
                      "Fixing goodbyes, re-announcing records. (" +
                        this._id +
                        ")"
                    );
                    return this._sendAnnouncement();
                  }

                  var conflicts = records.getConflicts(incoming);

                  if (conflicts.length) {
                    // if the conflicts are just due to a bridged packet, re-announce instead
                    if (this._bridgeable.hasEach(conflicts)) {
                      debug(
                        "Bridged packet detected, re-announcing records. (" +
                          this._id +
                          ")"
                      );
                      return this._sendAnnouncement();
                    }

                    // re-probe needed to verify uniqueness (doesn't rename until probing fails)
                    debug(
                      "Found conflict on incoming records, re-probing. (" +
                        this._id +
                        ")"
                    );
                    return this.transition("probing");
                  }
                }
              }
            ]);

            return Responder;
          })(StateMachine);

          module.exports = Responder;
        }.call(this, "/../dnssd.js/lib/Responder.js"));
      },
      {
        "./EventEmitter": 6,
        "./Probe": 11,
        "./RecordCollection": 14,
        "./Response": 17,
        "./StateMachine": 20,
        "./TimerContainer": 21,
        "./constants": 22,
        "./debug": 24,
        "./misc": 27,
        path: 40
      }
    ],
    17: [
      function(require, module, exports) {
        (function(__filename) {
          "use strict";

          function _toConsumableArray(arr) {
            if (Array.isArray(arr)) {
              for (var i = 0, arr2 = Array(arr.length); i < arr.length; i++) {
                arr2[i] = arr[i];
              }
              return arr2;
            } else {
              return Array.from(arr);
            }
          }

          var Packet = require("./Packet");
          var EventEmitter = require("./EventEmitter");
          var RecordCollection = require("./RecordCollection");
          var TimerContainer = require("./TimerContainer");
          var sleep = require("./sleep");
          var misc = require("./misc");

          var filename = require("path").basename(__filename);
          var debug = require("./debug")("dnssd:" + filename);

          var RType = require("./constants").RType;
          var ONE_SECOND = 1000;

          var counter = 0;
          var uniqueId = function uniqueId() {
            return "id#" + ++counter;
          };

          /**
           * Creates a new MulticastResponse
           * @class
           * @extends EventEmitter
           *
           * Sends out a multicast response of records on a given interface. Responses
           * can be set to repeat multiple times.
           *
           * @emits 'stopped'
           *
           * @param {NetworkInterface} intf - the interface the response will work on
           * @param {EventEmitter}     offswitch - emitter used to shut this response down
           */
          function MulticastResponse(intf, offswitch) {
            EventEmitter.call(this);

            // id only used for figuring out logs
            this._id = uniqueId();
            debug("Creating new response (" + this._id + ")");

            this._intf = intf;
            this._offswitch = offswitch;
            this._answers = new RecordCollection();
            this._isStopped = false;

            // defaults
            this._repeats = 1;
            this._delay = 0;
            this._isDefensive = false;

            // repeat responses, first at 1s apart, then increasing by a factor of 2
            this._next = ONE_SECOND;
            this._timers = new TimerContainer(this);

            // listen to answers on interface to suppress duplicate answers
            // stop on either the offswitch of an interface error
            intf
              .using(this)
              .on("answer", this._onAnswer)
              .once("error", this.stop);

            // waking from sleep should cause the response to stop too
            sleep.using(this).on("wake", this.stop);
            offswitch.using(this).once("stop", this.stop);
          }

          MulticastResponse.prototype = Object.create(EventEmitter.prototype);
          MulticastResponse.prototype.constructor = MulticastResponse;

          /**
           * Adds records to be sent out.
           * @param {ResourceRecords|ResourceRecords[]} arg
           */
          MulticastResponse.prototype.add = function(arg) {
            var records = Array.isArray(arg) ? arg : [arg];

            // In any case where there may be multiple responses, like when all outgoing
            // records are non-unique (like PTRs) response should be delayed 20-120 ms.
            this._delay = records.some(function(record) {
              return !record.isUnique;
            })
              ? misc.random(20, 120)
              : 0;
            this._answers.addEach(records);

            return this;
          };

          MulticastResponse.prototype.repeat = function(num) {
            this._repeats = num;
            return this;
          };

          /**
           * Some responses are 'defensive' in that they are responding to probes or
           * correcting some problem like an erroneous TTL=0.
           */
          MulticastResponse.prototype.defensive = function(bool) {
            this._isDefensive = !!bool;
            return this;
          };

          /**
           * Starts sending out records.
           */
          MulticastResponse.prototype.start = function() {
            // remove delay for defensive responses
            var delay = this._isDefensive ? 0 : this._delay;

            // prepare next outgoing packet in advance while listening to other answers
            // on the interface so duplicate answers in this packet can be suppressed.
            this._queuedPacket = this._makePacket();
            this._timers.setLazy("next-response", this._send, delay);

            return this;
          };

          /**
           * Stops the response & cleans up after itself.
           * @emits 'stopped' event when done
           */
          MulticastResponse.prototype.stop = function() {
            if (this._isStopped) return;

            debug("Response stopped (" + this._id + ")");
            this._isStopped = true;

            this._timers.clear();

            this._intf.removeListenersCreatedBy(this);
            this._offswitch.removeListenersCreatedBy(this);
            sleep.removeListenersCreatedBy(this);

            this.emit("stopped");
          };

          /**
           * Sends the response packets.
           *
           * socket.send() has a callback to know when the response was actually sent.
           * Responses shut down after repeats run out.
           */
          MulticastResponse.prototype._send = function() {
            var _this = this;

            this._repeats--;
            debug(
              "Sending response, " +
                this._repeats +
                " repeats left (" +
                this._id +
                ")"
            );

            var packet = this._suppressRecents(this._queuedPacket);

            // send packet, stop when all responses have been sent
            this._intf.send(packet, null, function() {
              if (_this._repeats <= 0) _this.stop();
            });

            // reschedule the next response if needed. the packet is prepared in advance
            // so incoming responses can be checked for duplicate answers.
            if (this._repeats > 0) {
              this._queuedPacket = this._makePacket();
              this._timers.setLazy("next-response", this._send, this._next);

              // each successive response increases delay by a factor of 2
              this._next *= 2;
            }
          };

          /**
           * Create a response packet.
           * @return {Packet}
           */
          MulticastResponse.prototype._makePacket = function() {
            var packet = new Packet();
            var additionals = new RecordCollection();

            this._answers.forEach(function(answer) {
              additionals.addEach(answer.additionals);
            });

            packet.setResponseBit();
            packet.setAnswers(this._answers.toArray());
            packet.setAdditionals(
              additionals.difference(this._answers).toArray()
            );

            return packet;
          };

          /**
           * Removes recently sent records from the outgoing packet
           *
           * Check the interface to for each outbound record. Records are limited to
           * being sent to the multicast address once every 1s except for probe responses
           * (and other defensive responses) that can be sent every 250ms.
           *
           * @param  {Packet} packet - the outgoing packet
           * @return {Packet}
           */
          MulticastResponse.prototype._suppressRecents = function(packet) {
            var _this2 = this;

            var range = this._isDefensive ? 0.25 : 1.0;

            var answers = packet.answers.filter(function(record) {
              return !_this2._intf.hasRecentlySent(record, range);
            });

            var suppressed = packet.answers.filter(function(a) {
              return !~answers.indexOf(a);
            });

            if (suppressed.length) {
              debug("Suppressing recently sent (%s): %r", this._id, suppressed);
              packet.setAnswers(answers);
            }

            return packet;
          };

          /**
           * Handles incoming answer (response) packets
           *
           * This is solely used to do duplicate answer suppression (7.4). If another
           * responder has sent the same answer as one this response is about to send,
           * this response can suppress that answer since someone else already sent it.
           * Modifies the next scheduled response packet only (this._queuedPacket).
           *
           * Note: this handle will receive this response's packets too
           *
           * @param {Packet} packet - the incoming probe packet
           */
          MulticastResponse.prototype._onAnswer = function(packet) {
            if (this._isStopped) return;

            // prevent this response from accidentally suppressing itself
            // (ignore packets that came from this interface)
            if (packet.isLocal()) return;

            // ignore goodbyes in suppression check
            var incoming = packet.answers.filter(function(answer) {
              return answer.ttl !== 0;
            });
            var outgoing = this._queuedPacket.answers;

            // suppress outgoing answers that also appear in incoming records
            var answers = new RecordCollection(outgoing)
              .difference(incoming)
              .toArray();
            var suppressed = outgoing.filter(function(out) {
              return !~answers.indexOf(out);
            });

            if (suppressed.length) {
              debug(
                "Suppressing duplicate answers (%s): %r",
                this._id,
                suppressed
              );
              this._queuedPacket.setAnswers(answers);
            }
          };

          /**
           * Creates a new GoodbyeResponse
           * @class
           * @extends MulticastResponse
           *
           * Sends out a multicast response of records that are now dead on an interface.
           * Goodbyes can be set to repeat multiple times.
           *
           * @emits 'stopped'
           *
           * @param {NetworkInterface} intf - the interface the response will work on
           * @param {EventEmitter}     offswitch - emitter used to shut this response down
           */
          function GoodbyeResponse(intf, offswitch) {
            MulticastResponse.call(this, intf, offswitch);
            debug("└─ a goodbye response");
          }

          GoodbyeResponse.prototype = Object.create(
            MulticastResponse.prototype
          );
          GoodbyeResponse.constructor = GoodbyeResponse;

          /**
           * Makes a goodbye packet
           * @return {Packet}
           */
          GoodbyeResponse.prototype._makePacket = function() {
            var packet = new Packet();

            // Records getting goodbye'd need a TTL=0
            // Clones are used so original records (held elsewhere) don't get mutated
            var answers = this._answers.map(function(record) {
              var clone = record.clone();
              clone.ttl = 0;
              return clone;
            });

            packet.setResponseBit();
            packet.setAnswers(answers);

            return packet;
          };

          // Don't suppress recents on goodbyes, return provided packet unchanged
          GoodbyeResponse.prototype._suppressRecents = function(p) {
            return p;
          };

          // Don't do answer suppression on goodbyes
          GoodbyeResponse.prototype._onAnswer = function() {};

          /**
           * Creates a new UnicastResponse
           * @class
           * @extends EventEmitter
           *
           * Sends out a unicast response to a destination. There are two types of
           * unicast responses here:
           *   - direct responses to QU questions (mDNS rules)
           *   - legacy responses (normal DNS packet rules)
           *
           * @emits 'stopped'
           *
           * @param {NetworkInterface} intf - the interface the response will work on
           * @param {EventEmitter}     offswitch - emitter used to shut this response down
           */
          function UnicastResponse(intf, offswitch) {
            EventEmitter.call(this);

            // id only used for figuring out logs
            this._id = uniqueId();
            debug("Creating a new unicast response (" + this._id + ")");

            this._intf = intf;
            this._offswitch = offswitch;
            this._answers = new RecordCollection();
            this._timers = new TimerContainer(this);

            // defaults
            this._delay = 0;
            this._isDefensive = false;

            // unicast & legacy specific
            this._destination = {};
            this._isLegacy = false;
            this._headerID = null;
            this._questions = null;

            // stops on offswitch event or interface errors
            intf.using(this).once("error", this.stop);
            offswitch.using(this).once("stop", this.stop);
            sleep.using(this).on("wake", this.stop);
          }

          UnicastResponse.prototype = Object.create(EventEmitter.prototype);
          UnicastResponse.prototype.constructor = UnicastResponse;

          /**
           * Adds records to be sent out.
           * @param {ResourceRecords|ResourceRecords[]} arg
           */
          UnicastResponse.prototype.add = function(arg) {
            var records = Array.isArray(arg) ? arg : [arg];

            // In any case where there may be multiple responses, like when all outgoing
            // records are non-unique (like PTRs) response should be delayed 20-120 ms.
            this._delay = records.some(function(record) {
              return !record.isUnique;
            })
              ? misc.random(20, 120)
              : 0;
            this._answers.addEach(records);

            return this;
          };

          UnicastResponse.prototype.defensive = function(bool) {
            this._isDefensive = !!bool;
            return this;
          };

          /**
           * Sets destination info based on the query packet this response is addressing.
           * Legacy responses will have to keep the questions and the packet ID for later.
           *
           * @param {Packet} packet - query packet to respond to
           */
          UnicastResponse.prototype.respondTo = function(packet) {
            this._destination.port = packet.origin.port;
            this._destination.address = packet.origin.address;

            if (packet.isLegacy()) {
              debug("preparing legacy response (" + this._id + ")");

              this._isLegacy = true;
              this._headerID = packet.header.ID;
              this._questions = packet.questions;

              this._questions.forEach(function(question) {
                question.QU = false;
              });
            }

            return this;
          };

          /**
           * Sends response packet to destination. Stops when packet has been sent.
           * No delay for defensive or legacy responses.
           */
          UnicastResponse.prototype.start = function() {
            var _this3 = this;

            var packet = this._makePacket();
            var delay = this._isDefensive || this._isLegacy ? 0 : this._delay;

            this._timers.setLazy(function() {
              debug("Sending unicast response (" + _this3._id + ")");

              _this3._intf.send(packet, _this3._destination, function() {
                return _this3.stop();
              });
            }, delay);

            return this;
          };

          /**
           * Stops response and cleans up.
           * @emits 'stopped' event when done
           */
          UnicastResponse.prototype.stop = function() {
            if (this._isStopped) return;

            debug("Unicast response stopped (" + this._id + ")");
            this._isStopped = true;

            this._timers.clear();

            this._intf.removeListenersCreatedBy(this);
            this._offswitch.removeListenersCreatedBy(this);
            sleep.removeListenersCreatedBy(this);

            this.emit("stopped");
          };

          /**
           * Makes response packet. Legacy response packets need special treatment.
           * @return {Packet}
           */
          UnicastResponse.prototype._makePacket = function() {
            var packet = new Packet();

            var answers = this._answers.toArray();
            var additionals = answers
              .reduce(function(result, answer) {
                return result.concat(answer.additionals);
              }, [])
              .filter(function(add) {
                return !~answers.indexOf(add);
              });

            additionals = [].concat(_toConsumableArray(new Set(additionals)));

            // Set TTL=10 on records for legacy responses. Use clones to prevent
            // altering the original record set.
            function legacyify(record) {
              var clone = record.clone();
              clone.isUnique = false;
              clone.ttl = 10;
              return clone;
            }

            if (this._isLegacy) {
              packet.header.ID = this._headerID;
              packet.setQuestions(this._questions);

              answers = answers
                .filter(function(record) {
                  return record.rrtype !== RType.NSEC;
                })
                .map(legacyify);

              additionals = additionals
                .filter(function(record) {
                  return record.rrtype !== RType.NSEC;
                })
                .map(legacyify);
            }

            packet.setResponseBit();
            packet.setAnswers(answers);
            packet.setAdditionals(additionals);

            return packet;
          };

          module.exports = {
            Multicast: MulticastResponse,
            Goodbye: GoodbyeResponse,
            Unicast: UnicastResponse
          };
        }.call(this, "/../dnssd.js/lib/Response.js"));
      },
      {
        "./EventEmitter": 6,
        "./Packet": 10,
        "./RecordCollection": 14,
        "./TimerContainer": 21,
        "./constants": 22,
        "./debug": 24,
        "./misc": 27,
        "./sleep": 29,
        path: 40
      }
    ],
    18: [
      function(require, module, exports) {
        (function(__filename) {
          "use strict";

          var _createClass = (function() {
            function defineProperties(target, props) {
              for (var i = 0; i < props.length; i++) {
                var descriptor = props[i];
                descriptor.enumerable = descriptor.enumerable || false;
                descriptor.configurable = true;
                if ("value" in descriptor) descriptor.writable = true;
                Object.defineProperty(target, descriptor.key, descriptor);
              }
            }
            return function(Constructor, protoProps, staticProps) {
              if (protoProps)
                defineProperties(Constructor.prototype, protoProps);
              if (staticProps) defineProperties(Constructor, staticProps);
              return Constructor;
            };
          })();

          function _toConsumableArray(arr) {
            if (Array.isArray(arr)) {
              for (var i = 0, arr2 = Array(arr.length); i < arr.length; i++) {
                arr2[i] = arr[i];
              }
              return arr2;
            } else {
              return Array.from(arr);
            }
          }

          function _classCallCheck(instance, Constructor) {
            if (!(instance instanceof Constructor)) {
              throw new TypeError("Cannot call a class as a function");
            }
          }

          function _possibleConstructorReturn(self, call) {
            if (!self) {
              throw new ReferenceError(
                "this hasn't been initialised - super() hasn't been called"
              );
            }
            return call &&
              (typeof call === "object" || typeof call === "function")
              ? call
              : self;
          }

          function _inherits(subClass, superClass) {
            if (typeof superClass !== "function" && superClass !== null) {
              throw new TypeError(
                "Super expression must either be null or a function, not " +
                  typeof superClass
              );
            }
            subClass.prototype = Object.create(
              superClass && superClass.prototype,
              {
                constructor: {
                  value: subClass,
                  enumerable: false,
                  writable: true,
                  configurable: true
                }
              }
            );
            if (superClass)
              Object.setPrototypeOf
                ? Object.setPrototypeOf(subClass, superClass)
                : (subClass.__proto__ = superClass);
          }

          var misc = require("./misc");
          var EventEmitter = require("./EventEmitter");
          var QueryRecord = require("./QueryRecord");

          var Query = require("./Query");
          var TimerContainer = require("./TimerContainer");
          var StateMachine = require("./StateMachine");

          var filename = require("path").basename(__filename);
          var debug = require("./debug")("dnssd:" + filename);

          var RType = require("./constants").RType;

          /**
           * Service Resolver
           *
           * In order to actually use a service discovered on the network, you need to
           * know the address of the service, the port its on, and any TXT data.
           * ServiceResponder takes a description of a service and any initial known
           * records and tries to find the missing pieces.
           *
           * ServiceResolver is a state machine with 3 states: unresolved, resolved, and
           * stopped. The resolver will stay active as long as knowledge about the
           * service is needed. The resolve will check for updates as service records go
           * stale and will notify if records expire and the service goes down.
           *
           */
          var resovlverStates = {
            unresolved: {
              enter: function enter() {
                var _this = this;

                debug("Service is unresolved");

                // Give resolver 10s to query and resolve. If it can't find
                // all the records it needs in 10s then something is probably wrong
                this._timers.set(
                  "timeout",
                  function() {
                    debug("Resolver timed out.");
                    _this.transition("stopped");
                  },
                  10 * 1000
                );

                this._queryForMissing();
              },
              incomingRecords: function incomingRecords(records) {
                var wasUpdated = this._processRecords(records);

                if (this.isResolved()) this.transition("resolved");
                else if (wasUpdated) this._queryForMissing();
              },
              reissue: function reissue(record) {
                this._batchReissue(record);
              },
              exit: function exit() {
                this._cancelQueries();
                this._timers.clear("timeout");
              }
            },

            resolved: {
              enter: function enter() {
                debug("Service is resolved");
                this.emit("resolved");
              },
              incomingRecords: function incomingRecords(records) {
                var wasUpdated = this._processRecords(records);

                if (!this.isResolved()) this.transition("unresolved");
                else if (wasUpdated) this.emit("updated");
              },
              reissue: function reissue(record) {
                this._batchReissue(record);
              },
              exit: function exit() {
                this._cancelQueries();
              }
            },

            stopped: {
              enter: function enter() {
                debug('Stopping resolver "' + this.fullname + '"');

                this._cancelQueries();
                this._removeListeners();

                this.emit("down");

                // override this.transition, because resolver is down now
                // (shouldn't be a problem anyway, more for debugging)
                this.transition = function() {
                  return debug("Service is down! Can't transition.");
                };
              }
            }
          };

          /**
           * Creates a new ServiceResolver
           * @class
           *
           * Fullname is the string describing the service to resolve, like:
           * 'Instance (2)._http._tcp.local.'
           *
           * @emits 'resovled'
           * @emits 'updated'
           * @emits 'down'
           *
           * @param  {string} fullname
           * @param  {Networkinterfaces} intf
           * @return {ServiceResolver}
           */

          var ServiceResolver = (function(_StateMachine) {
            _inherits(ServiceResolver, _StateMachine);

            function ServiceResolver(fullname, intf) {
              _classCallCheck(this, ServiceResolver);

              debug('Creating new resolver for "' + fullname + '"');

              var _this2 = _possibleConstructorReturn(
                this,
                (
                  ServiceResolver.__proto__ ||
                  Object.getPrototypeOf(ServiceResolver)
                ).call(this, resovlverStates)
              );

              _this2.fullname = fullname;
              _this2._interface = intf;

              var parts = misc.parse(fullname);
              _this2.instance = parts.instance;
              _this2.serviceType = parts.service;
              _this2.protocol = parts.protocol;
              _this2.domain = parts.domain;

              // e.g. _http._tcp.local.
              _this2.ptrname = misc.fqdn(
                _this2.serviceType,
                _this2.protocol,
                _this2.domain
              );

              // info required for resolution
              _this2.addresses = [];
              _this2.target = null;
              _this2.port = null;
              _this2.txt = null;
              _this2.txtRaw = null;

              // keep one consistent service object so they resolved services can be
              // compared by object reference or kept in a set/map
              _this2._service = {};

              // dirty flag to track changes to service info. gets reset to false before
              // each incoming answer packet is checked.
              _this2._changed = false;

              // offswitch used to communicate with & stop child queries instead of
              // holding onto a reference for each one
              _this2._offswitch = new EventEmitter();

              _this2._batch = [];
              _this2._timers = new TimerContainer(_this2);
              return _this2;
            }

            /**
             * Starts the resolver and parses optional starting records
             * @param {ResourceRecords[]} records
             */

            _createClass(ServiceResolver, [
              {
                key: "start",
                value: function start(records) {
                  debug("Starting resolver");

                  this._addListeners();

                  if (records) {
                    debug.verbose("Adding initial records: %r", records);
                    this._processRecords(records);
                  }

                  this.isResolved()
                    ? this.transition("resolved")
                    : this.transition("unresolved");
                }
              },
              {
                key: "stop",
                value: function stop() {
                  debug("Stopping resolver");
                  this.transition("stopped");
                }

                /**
                 * Returns the service that has been resolved. Always returns the same obj
                 * reference so they can be included in sets/maps or be compared however.
                 *
                 * addresses/txt/txtRaw are all cloned so any accidental changes to them
                 * won't cause problems within the resolver.
                 *
                 * Ex: {
                 *   fullname : 'Instance (2)._http._tcp.local.',
                 *   name     : 'Instance (2)',
                 *   type     : {name: 'http', protocol: 'tcp'},
                 *   domain   : 'local',
                 *   host     : 'target.local.',
                 *   port     : 8888,
                 *   addresses: ['192.168.1.1', '::1'],
                 *   txt      : {key: 'value'},
                 *   txtRaw   : {key: <Buffer 76 61 6c 75 65>},
                 * }
                 *
                 * @return {object}
                 */
              },
              {
                key: "service",
                value: function service() {
                  // remove any leading underscores
                  var serviceType = this.serviceType.replace(/^_/, "");
                  var protocol = this.protocol.replace(/^_/, "");

                  // re-assign/update properties
                  this._service.fullname = this.fullname;
                  this._service.name = this.instance;
                  this._service.type = {
                    name: serviceType,
                    protocol: protocol
                  };
                  this._service.domain = this.domain;
                  this._service.host = this.target;
                  this._service.port = this.port;
                  this._service.addresses = this.addresses.slice();
                  this._service.txt = this.txt
                    ? Object.assign({}, this.txt)
                    : {};
                  this._service.txtRaw = this.txtRaw
                    ? Object.assign({}, this.txtRaw)
                    : {};

                  // always return same obj
                  return this._service;
                }
              },
              {
                key: "isResolved",
                value: function isResolved() {
                  return (
                    !!this.addresses.length &&
                    !!this.target &&
                    !!this.port &&
                    !!this.txtRaw
                  );
                }

                /**
                 * Listen to new answers coming to the interfaces. Do stuff when interface
                 * caches report that a record needs to be refreshed or when it expires.
                 * Stop on interface errors.
                 */
              },
              {
                key: "_addListeners",
                value: function _addListeners() {
                  var _this3 = this;

                  this._interface
                    .using(this)
                    .on("answer", this._onAnswer)
                    .once("error", function(err) {
                      return _this3.transition("stopped", err);
                    });

                  this._interface.cache
                    .using(this)
                    .on("reissue", this._onReissue)
                    .on("expired", this._onExpired);
                }
              },
              {
                key: "_removeListeners",
                value: function _removeListeners() {
                  this._interface.removeListenersCreatedBy(this);
                  this._interface.cache.removeListenersCreatedBy(this);
                }
              },
              {
                key: "_onAnswer",
                value: function _onAnswer(packet) {
                  this.handle(
                    "incomingRecords",
                    [].concat(
                      _toConsumableArray(packet.answers),
                      _toConsumableArray(packet.additionals)
                    )
                  );
                }

                /**
                 * As cached records go stale they need to be refreshed. The cache will ask
                 * for updates to records as they reach 80% 85% 90% and 95% of their TTLs.
                 * This listens to all reissue events from the cache and checks if the record
                 * is relevant to this resolver. If it is, the fsm will handle it based on
                 * what state its currently in.
                 *
                 * If the SRV record needs to be updated the PTR is queried too. Some dumb
                 * responders seem more likely to answer the PTR question.
                 */
              },
              {
                key: "_onReissue",
                value: function _onReissue(record) {
                  var isRelevant =
                    record.matches({ name: this.fullname }) ||
                    record.matches({
                      name: this.ptrname,
                      PTRDName: this.fullname
                    }) ||
                    record.matches({ name: this.target });

                  var isSRV = record.matches({
                    rrtype: RType.SRV,
                    name: this.fullname
                  });

                  if (isRelevant) {
                    this.handle("reissue", record);
                  }

                  if (isSRV) {
                    this.handle("reissue", {
                      name: this.ptrname,
                      rrtype: RType.PTR
                    });
                  }
                }

                /**
                 * Check records as they expire from the cache. This how the resolver learns
                 * that a service has died instead of from goodbye records with TTL=0's.
                 * Goodbye's only tell the cache to purge the records in 1s and the resolver
                 * should ignore those.
                 */
              },
              {
                key: "_onExpired",
                value: function _onExpired(record) {
                  // PTR/SRV: transition to stopped, service is down
                  var isDown =
                    record.matches({
                      rrtype: RType.SRV,
                      name: this.fullname
                    }) ||
                    record.matches({
                      rrtype: RType.PTR,
                      name: this.ptrname,
                      PTRDName: this.fullname
                    });

                  // A/AAAA: remove address & transition to unresolved if none are left
                  var isAddress =
                    record.matches({ rrtype: RType.A, name: this.target }) ||
                    record.matches({ rrtype: RType.AAAA, name: this.target });

                  // TXT: remove txt & transition to unresolved
                  var isTXT = record.matches({
                    rrtype: RType.TXT,
                    name: this.fullname
                  });

                  if (isDown) {
                    debug("Service expired, resolver going down. (%s)", record);
                    this.transition("stopped");
                  }

                  if (isAddress) {
                    debug("Address record expired, removing. (%s)", record);

                    this.addresses = this.addresses.filter(function(add) {
                      return add !== record.address;
                    });
                    if (!this.addresses.length) this.transition("unresolved");
                  }

                  if (isTXT) {
                    debug("TXT record expired, removing. (%s)", record);
                    this.txt = null;
                    this.txtRaw = null;
                    this.transition("unresolved");
                  }
                }

                /**
                 * Checks incoming records for changes or updates. Returns true if anything
                 * happened.
                 *
                 * @param  {ResourceRecord[]} incoming
                 * @return {boolean}
                 */
              },
              {
                key: "_processRecords",
                value: function _processRecords(incoming) {
                  var _this4 = this;

                  // reset changes flag before checking records
                  this._changed = false;

                  // Ignore TTL 0 records. Get expiration events from the caches instead
                  var records = incoming.filter(function(record) {
                    return record.ttl > 0;
                  });
                  if (!records.length) return false;

                  var findOne = function findOne(params) {
                    return records.find(function(record) {
                      return record.matches(params);
                    });
                  };
                  var findAll = function findAll(params) {
                    return records.filter(function(record) {
                      return record.matches(params);
                    });
                  };

                  // SRV/TXT before A/AAAA, since they contain the target for A/AAAA records
                  var SRV = findOne({ rrtype: RType.SRV, name: this.fullname });
                  var TXT = findOne({ rrtype: RType.TXT, name: this.fullname });

                  if (SRV) this._processSRV(SRV);
                  if (TXT) this._processTXT(TXT);

                  if (!this.target) return this._changed;

                  var As = findAll({ rrtype: RType.A, name: this.target });
                  var AAAAs = findAll({
                    rrtype: RType.AAAA,
                    name: this.target
                  });

                  if (As.length)
                    As.forEach(function(A) {
                      return _this4._processAddress(A);
                    });
                  if (AAAAs.length)
                    AAAAs.forEach(function(AAAA) {
                      return _this4._processAddress(AAAA);
                    });

                  return this._changed;
                }
              },
              {
                key: "_processSRV",
                value: function _processSRV(record) {
                  if (this.port !== record.port) {
                    this.port = record.port;
                    this._changed = true;
                  }

                  // if the target changes the addresses are no longer valid
                  if (this.target !== record.target) {
                    this.target = record.target;
                    this.addresses = [];
                    this._changed = true;
                  }
                }
              },
              {
                key: "_processTXT",
                value: function _processTXT(record) {
                  if (!misc.equals(this.txtRaw, record.txtRaw)) {
                    this.txtRaw = record.txtRaw;
                    this.txt = record.txt;
                    this._changed = true;
                  }
                }
              },
              {
                key: "_processAddress",
                value: function _processAddress(record) {
                  if (this.addresses.indexOf(record.address) === -1) {
                    this.addresses.push(record.address);
                    this._changed = true;
                  }
                }

                /**
                 * Tries to get info that is missing and needed for the service to resolve.
                 * Checks the interface caches first and then sends out queries for whatever
                 * is still missing.
                 */
              },
              {
                key: "_queryForMissing",
                value: function _queryForMissing() {
                  debug("Getting missing records");

                  var questions = [];

                  // get missing SRV
                  if (!this.target)
                    questions.push({ name: this.fullname, qtype: RType.SRV });

                  // get missing TXT
                  if (!this.txtRaw)
                    questions.push({ name: this.fullname, qtype: RType.TXT });

                  // get missing A/AAAA
                  if (this.target && !this.addresses.length) {
                    questions.push({ name: this.target, qtype: RType.A });
                    questions.push({ name: this.target, qtype: RType.AAAA });
                  }

                  // check interface caches for answers first
                  this._checkCache(questions);

                  // send out queries for what is still unanswered
                  // (_checkCache may have removed all/some questions from the list)
                  if (questions.length) this._sendQueries(questions);
                }

                /**
                 * Checks the cache for missing records. Tells the fsm to handle new records
                 * if it finds anything
                 */
              },
              {
                key: "_checkCache",
                value: function _checkCache(questions) {
                  var _this5 = this;

                  debug("Checking cache for needed records");

                  var answers = [];

                  // check cache for answers to each question
                  questions.forEach(function(question, index) {
                    var results = _this5._interface.cache.find(
                      new QueryRecord(question)
                    );

                    if (results && results.length) {
                      // remove answered questions from list
                      questions.splice(index, 1);
                      answers.push.apply(answers, _toConsumableArray(results));
                    }
                  });

                  // process any found records
                  answers.length && this.handle("incomingRecords", answers);
                }

                /**
                 * Sends queries out on each interface for needed records. Queries are
                 * continuous, they keep asking until they get the records or until they
                 * are stopped by the resolver with `this._cancelQueries()`.
                 */
              },
              {
                key: "_sendQueries",
                value: function _sendQueries(questions) {
                  debug("Sending queries for needed records");

                  // stop any existing queries, they might be stale now
                  this._cancelQueries();

                  // no 'answer' event handler here because this resolver is already
                  // listening to the interface 'answer' event
                  new Query(this._interface, this._offswitch)
                    .ignoreCache(true)
                    .add(questions)
                    .start();
                }

                /**
                 * Reissue events from the cache are slightly randomized for each record's TTL
                 * (80-82%, 85-87% of the TTL, etc) so reissue queries are batched here to
                 * prevent a bunch of outgoing queries from being sent back to back 10ms apart.
                 */
              },
              {
                key: "_batchReissue",
                value: function _batchReissue(record) {
                  var _this6 = this;

                  debug("Batching record for reissue %s", record);

                  this._batch.push(record);

                  if (!this._timers.has("batch")) {
                    this._timers.setLazy(
                      "batch",
                      function() {
                        _this6._sendReissueQuery(_this6._batch);
                        _this6._batch = [];
                      },
                      1 * 1000
                    );
                  }
                }

                /**
                 * Asks for updates to records. Only sends one query out (non-continuous).
                 */
              },
              {
                key: "_sendReissueQuery",
                value: function _sendReissueQuery(records) {
                  debug("Reissuing query for cached records: %r", records);

                  var questions = records.map(function(_ref) {
                    var name = _ref.name,
                      rrtype = _ref.rrtype;
                    return { name: name, qtype: rrtype };
                  });

                  new Query(this._interface, this._offswitch)
                    .continuous(false) // only send query once, don't need repeats
                    .ignoreCache(true) // ignore cache, trying to renew this record
                    .add(questions)
                    .start();
                }
              },
              {
                key: "_cancelQueries",
                value: function _cancelQueries() {
                  debug(
                    "Sending stop signal to active queries & canceling batched"
                  );
                  this._offswitch.emit("stop");
                  this._timers.clear("batch");
                }
              }
            ]);

            return ServiceResolver;
          })(StateMachine);

          module.exports = ServiceResolver;
        }.call(this, "/../dnssd.js/lib/ServiceResolver.js"));
      },
      {
        "./EventEmitter": 6,
        "./Query": 12,
        "./QueryRecord": 13,
        "./StateMachine": 20,
        "./TimerContainer": 21,
        "./constants": 22,
        "./debug": 24,
        "./misc": 27,
        path: 40
      }
    ],
    19: [
      function(require, module, exports) {
        "use strict";

        var _typeof =
          typeof Symbol === "function" && typeof Symbol.iterator === "symbol"
            ? function(obj) {
                return typeof obj;
              }
            : function(obj) {
                return obj &&
                  typeof Symbol === "function" &&
                  obj.constructor === Symbol &&
                  obj !== Symbol.prototype
                  ? "symbol"
                  : typeof obj;
              };

        var _createClass = (function() {
          function defineProperties(target, props) {
            for (var i = 0; i < props.length; i++) {
              var descriptor = props[i];
              descriptor.enumerable = descriptor.enumerable || false;
              descriptor.configurable = true;
              if ("value" in descriptor) descriptor.writable = true;
              Object.defineProperty(target, descriptor.key, descriptor);
            }
          }
          return function(Constructor, protoProps, staticProps) {
            if (protoProps) defineProperties(Constructor.prototype, protoProps);
            if (staticProps) defineProperties(Constructor, staticProps);
            return Constructor;
          };
        })();

        function _toConsumableArray(arr) {
          if (Array.isArray(arr)) {
            for (var i = 0, arr2 = Array(arr.length); i < arr.length; i++) {
              arr2[i] = arr[i];
            }
            return arr2;
          } else {
            return Array.from(arr);
          }
        }

        function _toArray(arr) {
          return Array.isArray(arr) ? arr : Array.from(arr);
        }

        function _classCallCheck(instance, Constructor) {
          if (!(instance instanceof Constructor)) {
            throw new TypeError("Cannot call a class as a function");
          }
        }

        var validate = require("./validate");
        var ValidationError = require("./customError").create(
          "ValidationError"
        );

        /**
         * Creates a new ServiceType
         * @class
         *
         * Used to turn some input into a reliable service type for advertisements and
         * browsers. Does validation on input, throwing errors if there's a problem.
         *
         * Name and protocol are always required, subtypes are optional.
         *
         * String (single argument):
         *   '_http._tcp'
         *   '_http._tcp,mysubtype,anothersub'
         *
         * Object (single argument):
         *   {
         *     name:     '_http',
         *     protocol: '_tcp',
         *     subtypes: ['mysubtype', 'anothersub'],
         *   }
         *
         * Array (single argument):
         *   ['_http', '_tcp', ['mysubtype', 'anothersub']]
         *   ['_http', '_tcp', 'mysubtype', 'anothersub']
         *
         * Strings (multiple arguments):
         *   '_http', '_tcp'
         *   '_http', '_tcp', 'mysubtype', 'anothersub'
         *
         * Validation step is forgiving about required leading underscores and
         * will add them it missing. So 'http.tcp' would be the same as '_http._tcp'.
         *
         * @param {string|object|array|...string} arguments
         */

        var ServiceType = (function() {
          function ServiceType() {
            _classCallCheck(this, ServiceType);

            for (
              var _len = arguments.length, args = Array(_len), _key = 0;
              _key < _len;
              _key++
            ) {
              args[_key] = arguments[_key];
            }

            var input = args.length === 1 ? args[0] : args;

            this.name = null;
            this.protocol = null;
            this.subtypes = [];
            this.isEnumerator = false;

            var type =
              typeof input === "undefined" ? "undefined" : _typeof(input);

            if (type === "string") this._fromString(input);
            else if (Array.isArray(input)) this._fromArray(input);
            else if (type === "object") this._fromObj(input);
            else {
              throw new ValidationError(
                "Argument must be string, obj, or array. got %s",
                type
              );
            }

            this._validate();
          }

          /**
           * Creates a new ServiceType with tcp protocol
           * Ex:
           *   ServiceType.tcp('_http')
           *   ServiceType.tcp('_http', 'sub1', 'sub2')
           *   ServiceType.tcp(['_http', 'sub1', 'sub2'])
           *
           * @param  {string|array|...string} arguments
           * @return {ServiceType}
           */

          _createClass(
            ServiceType,
            [
              {
                key: "_fromString",

                /**
                 * Parse a string into service parts
                 * Ex:
                 *   '_http._tcp'
                 *   '_http._tcp,mysubtype,anothersub'
                 */
                value: function _fromString(str) {
                  // trim off weird whitespace and extra trailing commas
                  var parts = str
                    .replace(/^[ ,]+|[ ,]+$/g, "")
                    .split(",")
                    .map(function(s) {
                      return s.trim();
                    });

                  this.name = parts[0]
                    .split(".")
                    .slice(0, -1)
                    .join(".");
                  this.protocol = parts[0].split(".").slice(-1)[0];
                  this.subtypes = parts.slice(1);
                }

                /**
                 * Parse an array into service parts
                 * Ex:
                 *   ['_http', '_tcp', ['mysubtype', 'anothersub']]
                 *   ['_http', '_tcp', 'mysubtype', 'anothersub']
                 */
              },
              {
                key: "_fromArray",
                value: function _fromArray(_ref) {
                  var _ref3;

                  var _ref2 = _toArray(_ref),
                    name = _ref2[0],
                    protocol = _ref2[1],
                    subtypes = _ref2.slice(2);

                  this._fromObj({
                    name: name,
                    protocol: protocol,
                    subtypes: (_ref3 = []).concat.apply(
                      _ref3,
                      _toConsumableArray(subtypes)
                    )
                  });
                }

                /**
                 * Parse an object into service parts
                 * Ex: {
                 *   name:     '_http',
                 *   protocol: '_tcp',
                 *   subtypes: ['mysubtype', 'anothersub'],
                 * }
                 */
              },
              {
                key: "_fromObj",
                value: function _fromObj(_ref4) {
                  var name = _ref4.name,
                    protocol = _ref4.protocol,
                    _ref4$subtypes = _ref4.subtypes,
                    subtypes =
                      _ref4$subtypes === undefined ? [] : _ref4$subtypes;

                  this.name = name;
                  this.protocol = protocol;
                  this.subtypes = Array.isArray(subtypes)
                    ? subtypes
                    : [subtypes];
                }

                /**
                 * Validates service name, protocol, and subtypes. Throws if any of them
                 * are invalid.
                 */
              },
              {
                key: "_validate",
                value: function _validate() {
                  if (typeof this.name !== "string") {
                    throw new ValidationError(
                      "Service name must be a string, got %s",
                      _typeof(this.name)
                    );
                  }

                  if (!this.name) {
                    throw new ValidationError("Service name can't be empty");
                  }

                  if (typeof this.protocol !== "string") {
                    throw new ValidationError(
                      "Protocol must be a string, got %s",
                      _typeof(this.protocol)
                    );
                  }

                  if (!this.protocol) {
                    throw new ValidationError("Protocol can't be empty");
                  }

                  // massage properties a little before validating
                  // be lenient about underscores, add when missing
                  if (this.name.substr(0, 1) !== "_")
                    this.name = "_" + this.name;
                  if (this.protocol.substr(0, 1) !== "_")
                    this.protocol = "_" + this.protocol;

                  // special case: check this service type is the service enumerator
                  if (
                    this.name === "_services._dns-sd" &&
                    this.protocol === "_udp"
                  ) {
                    this.isEnumerator = true;

                    // enumerators shouldn't have subtypes
                    this.subtypes = [];

                    // skip validation for service enumerators, they would fail since
                    // '_services._dns-sd' is getting shoehorned into this.name
                    return;
                  }

                  validate.serviceName(this.name);
                  validate.protocol(this.protocol);
                  this.subtypes.forEach(function(subtype) {
                    return validate.label(subtype, "Subtype");
                  });
                }

                /**
                 * A string representation of the service
                 * ex: '_http._tcp,sub1,sub2'
                 */
              },
              {
                key: "toString",
                value: function toString() {
                  return this.subtypes.length
                    ? this.name +
                        "." +
                        this.protocol +
                        "," +
                        this.subtypes.join(",")
                    : this.name + "." + this.protocol;
                }
              }
            ],
            [
              {
                key: "tcp",
                value: function tcp() {
                  var _ref5;

                  // insert protocol in the right spot (second arg)
                  var input = (_ref5 = []).concat.apply(_ref5, arguments);
                  input.splice(1, 0, "_tcp");

                  return new ServiceType(input);
                }

                /**
                 * Creates a new ServiceType with udp protocol
                 * Ex:
                 *   ServiceType.tcp('_sleep-proxy,sub1,sub2')
                 *   ServiceType.tcp('_sleep-proxy', 'sub1', 'sub2')
                 *   ServiceType.tcp(['_sleep-proxy', 'sub1', 'sub2'])
                 *
                 * @param  {string|array|...string} [arguments]
                 * @return {ServiceType}
                 */
              },
              {
                key: "udp",
                value: function udp() {
                  var _ref6;

                  // insert protocol in the right spot (second arg)
                  var input = (_ref6 = []).concat.apply(_ref6, arguments);
                  input.splice(1, 0, "_udp");

                  return new ServiceType(input);
                }

                /**
                 * Creates a new service enumerator
                 * @return {ServiceType}
                 */
              },
              {
                key: "all",
                value: function all() {
                  return new ServiceType("_services._dns-sd._udp");
                }
              }
            ]
          );

          return ServiceType;
        })();

        module.exports = ServiceType;
      },
      { "./customError": 23, "./validate": 30 }
    ],
    20: [
      function(require, module, exports) {
        "use strict";

        var _createClass = (function() {
          function defineProperties(target, props) {
            for (var i = 0; i < props.length; i++) {
              var descriptor = props[i];
              descriptor.enumerable = descriptor.enumerable || false;
              descriptor.configurable = true;
              if ("value" in descriptor) descriptor.writable = true;
              Object.defineProperty(target, descriptor.key, descriptor);
            }
          }
          return function(Constructor, protoProps, staticProps) {
            if (protoProps) defineProperties(Constructor.prototype, protoProps);
            if (staticProps) defineProperties(Constructor, staticProps);
            return Constructor;
          };
        })();

        function _classCallCheck(instance, Constructor) {
          if (!(instance instanceof Constructor)) {
            throw new TypeError("Cannot call a class as a function");
          }
        }

        var events = require("events");

        var has = function has(obj, prop) {
          return Object.prototype.hasOwnProperty.call(obj, prop);
        };

        var StateMachine = (function() {
          function StateMachine(states) {
            _classCallCheck(this, StateMachine);

            this.state = "";
            this.prevState = "";
            this.states = states;

            var emitter = new events.EventEmitter();
            this.emit = emitter.emit.bind(emitter);
            this.once = emitter.once.bind(emitter);
            this.on = emitter.on.bind(emitter);
            this.off = emitter.removeListener.bind(emitter);
          }

          _createClass(StateMachine, [
            {
              key: "_apply",
              value: function _apply(state, fn) {
                if (has(this.states, state) && has(this.states[state], fn)) {
                  var _states$state$fn;

                  for (
                    var _len = arguments.length,
                      args = Array(_len > 2 ? _len - 2 : 0),
                      _key = 2;
                    _key < _len;
                    _key++
                  ) {
                    args[_key - 2] = arguments[_key];
                  }

                  (_states$state$fn = this.states[state][fn]).call.apply(
                    _states$state$fn,
                    [this].concat(args)
                  );
                }
              }
            },
            {
              key: "transition",
              value: function transition(to) {
                if (!has(this.states, to)) {
                  throw new Error(
                    "Can't transition, state " + to + " doesn't exist!"
                  );
                }

                this.prevState = this.state;
                this.state = to;

                this._apply(this.prevState, "exit");

                for (
                  var _len2 = arguments.length,
                    args = Array(_len2 > 1 ? _len2 - 1 : 0),
                    _key2 = 1;
                  _key2 < _len2;
                  _key2++
                ) {
                  args[_key2 - 1] = arguments[_key2];
                }

                this._apply.apply(this, [this.state, "enter"].concat(args));
              }
            },
            {
              key: "handle",
              value: function handle(input) {
                for (
                  var _len3 = arguments.length,
                    args = Array(_len3 > 1 ? _len3 - 1 : 0),
                    _key3 = 1;
                  _key3 < _len3;
                  _key3++
                ) {
                  args[_key3 - 1] = arguments[_key3];
                }

                this._apply.apply(this, [this.state, input].concat(args));
              }
            }
          ]);

          return StateMachine;
        })();

        module.exports = StateMachine;
      },
      { events: 37 }
    ],
    21: [
      function(require, module, exports) {
        "use strict";

        var _createClass = (function() {
          function defineProperties(target, props) {
            for (var i = 0; i < props.length; i++) {
              var descriptor = props[i];
              descriptor.enumerable = descriptor.enumerable || false;
              descriptor.configurable = true;
              if ("value" in descriptor) descriptor.writable = true;
              Object.defineProperty(target, descriptor.key, descriptor);
            }
          }
          return function(Constructor, protoProps, staticProps) {
            if (protoProps) defineProperties(Constructor.prototype, protoProps);
            if (staticProps) defineProperties(Constructor, staticProps);
            return Constructor;
          };
        })();

        function _classCallCheck(instance, Constructor) {
          if (!(instance instanceof Constructor)) {
            throw new TypeError("Cannot call a class as a function");
          }
        }

        var counter = 0;
        var uniqueId = function uniqueId() {
          return ++counter;
        };

        /**
         * TimerContainer is a convenience wrapper for setting/clearing timers
         * plus "lazy" timers that won't fire after waking from sleep.
         * @class
         *
         *  Instead of this:
         *     this.timeout = setTimeout(this.stop.bind(this));
         *     this.doSomehting = setTimeout(...);
         *     this.doThat = setTimeout(...);
         *     ... x10
         *
         *     clearTimeout(this.timeout)      <-- have to keep track of each
         *     clearTimeout(this.doSomething)
         *     clearTimeout(this.doThat)
         *
         * Do this:
         *     this.timers = new TimerContext(this);
         *     this.timers.set('timeout', this.stop, 1000);
         *     this.timers.set(fn1, 100);
         *     this.timers.set(fn2, 200);
         *     ...
         *
         *     this.timers.clear(); <-- clears all, only need to track this.timers
         *
         * Lazy timers that won't fire when walking from sleep. If a js timer
         * is set and the machine goes to sleep the timer will fire as soon as the
         * machine wakes from sleep. This behavior isn't always wanted. Lazy timers
         * won't fire if they are going off later than they are supposed to.
         *
         * Ex:
         *     timers.setLazy(doTimeSensitive, 1000)
         *     > machine sleeps for 1hr
         *     > machine wakes
         *     > doTimeSensitive doesn't fire
         *
         */

        var TimerContainer = (function() {
          /**
           * Optional context. If used timer functions will be applied with it.
           * @param {object} [context]
           */
          function TimerContainer(context) {
            _classCallCheck(this, TimerContainer);

            this._context = context;
            this._timers = {};
            this._lazyTimers = {};
          }

          _createClass(TimerContainer, [
            {
              key: "has",
              value: function has(id) {
                return (
                  this._timers.hasOwnProperty(id) ||
                  this._lazyTimers.hasOwnProperty(id)
                );
              }
            },
            {
              key: "count",
              value: function count() {
                return (
                  Object.keys(this._timers).length +
                  Object.keys(this._lazyTimers).length
                );
              }

              /**
               * Set a normal timeout (like plain setTimeout)
               *
               * @param {string}   [id] - optional id for timer (so it can be cleared by id later)
               * @param {function} fn
               * @param {number}   delay
               */
            },
            {
              key: "set",
              value: function set() {
                var _this = this;

                for (
                  var _len = arguments.length, args = Array(_len), _key = 0;
                  _key < _len;
                  _key++
                ) {
                  args[_key] = arguments[_key];
                }

                var delay = args.pop();
                var fn = args.pop();
                var id = args.length ? args.pop() : uniqueId();

                // clear previous duplicates
                if (this._timers[id]) this.clear(id);

                this._timers[id] = setTimeout(function() {
                  // remove timer key BERORE running the fn
                  // (fn could set another timer with the same id, screwing everything up)
                  delete _this._timers[id];
                  fn.call(_this._context);
                }, delay);
              }

              /**
               * Set a 'lazy' timeout that won't call it's fn if the timer fires later
               * than expected. (Won't fire after waking from sleep.)
               *
               * @param {string}   [id] - optional id for timer (so it can be cleared by id later)
               * @param {function} fn
               * @param {number}   delay
               */
            },
            {
              key: "setLazy",
              value: function setLazy() {
                var _this2 = this;

                for (
                  var _len2 = arguments.length, args = Array(_len2), _key2 = 0;
                  _key2 < _len2;
                  _key2++
                ) {
                  args[_key2] = arguments[_key2];
                }

                var delay = args.pop();
                var fn = args.pop();
                var id = args.length ? args.pop() : uniqueId();

                // expect timer to fire after delay +- 5s fudge factor
                // only fire fn if the timer is firing when it was expected to (not after
                // waking from sleep)
                var finish = Date.now() + delay + 5 * 1000;

                // clear previous duplicates
                if (this._lazyTimers[id]) this.clear(id);

                this._lazyTimers[id] = setTimeout(function() {
                  // remove timer key BERORE running the fn
                  // (fn could set another timer with the same id)
                  delete _this2._lazyTimers[id];
                  if (Date.now() < finish) fn.call(_this2._context);
                }, delay);
              }

              /**
               * Clear specific timer or clear all
               * @param {string} [id] - specific timer to clear
               */
            },
            {
              key: "clear",
              value: function clear(id) {
                var _this3 = this;

                if (!id) {
                  Object.keys(this._timers).forEach(function(timer) {
                    return _this3.clear(timer);
                  });
                  Object.keys(this._lazyTimers).forEach(function(timer) {
                    return _this3.clear(timer);
                  });
                }

                if (this._timers.hasOwnProperty(id)) {
                  clearTimeout(this._timers[id]);
                  delete this._timers[id];
                }

                if (this._lazyTimers.hasOwnProperty(id)) {
                  clearTimeout(this._lazyTimers[id]);
                  delete this._lazyTimers[id];
                }
              }
            }
          ]);

          return TimerContainer;
        })();

        module.exports = TimerContainer;
      },
      {}
    ],
    22: [
      function(require, module, exports) {
        "use strict";

        module.exports.RType = {
          A: 1,
          PTR: 12,
          TXT: 16,
          AAAA: 28,
          SRV: 33,
          NSEC: 47,
          ANY: 255
        };

        module.exports.RClass = {
          IN: 1,
          ANY: 255
        };

        module.exports.RNums = {
          1: "A",
          12: "PTR",
          16: "TXT",
          28: "AAAA",
          33: "SRV",
          47: "NSEC",
          255: "ANY"
        };
      },
      {}
    ],
    23: [
      function(require, module, exports) {
        "use strict";

        var misc = require("./misc");

        /**
         * Custom error type w/ msg formatting
         *
         * const MyError = customError.create('MyError');
         * throw new MyError('Msg %s %d', 'stuff', 10);
         *
         * @param  {string} errorType
         * @return {Error}
         */
        module.exports.create = function createErrorType(errorType) {
          function CustomError(message) {
            this.name = errorType;

            for (
              var _len = arguments.length,
                args = Array(_len > 1 ? _len - 1 : 0),
                _key = 1;
              _key < _len;
              _key++
            ) {
              args[_key - 1] = arguments[_key];
            }

            this.message = misc.format.apply(misc, [message].concat(args));

            Error.captureStackTrace(this, CustomError);
          }

          CustomError.prototype = Object.create(Error.prototype);
          CustomError.prototype.constructor = CustomError;

          return CustomError;
        };
      },
      { "./misc": 27 }
    ],
    24: [
      function(require, module, exports) {
        (function(process) {
          "use strict";

          var misc = require("./misc");

          var enabledNamespaces = [];
          var disabledNamespaces = [];

          var enabledVerbose = [];
          var disabledVerbose = [];

          var colors = ["blue", "green", "magenta", "yellow", "cyan", "red"];
          var colorsIndex = 0;

          var noop = function noop() {};
          noop.verbose = noop;
          noop.v = noop;
          noop.isEnabled = false;
          noop.verbose.isEnabled = false;
          noop.v.isEnabled = false;

          var logger = console.log;

          // initialize
          if (process.env.DEBUG) {
            process.env.DEBUG.replace(/\*/g, ".*?")
              .split(",")
              .filter(function(s) {
                return !!s;
              })
              .forEach(function(namespace) {
                namespace.substr(0, 1) === "-"
                  ? disabledNamespaces.push(namespace.substr(1))
                  : enabledNamespaces.push(namespace);
              });
          }

          if (process.env.VERBOSE) {
            process.env.VERBOSE.replace(/\*/g, ".*?")
              .split(",")
              .filter(function(s) {
                return !!s;
              })
              .forEach(function(namespace) {
                namespace.substr(0, 1) === "-"
                  ? disabledVerbose.push(namespace.substr(1))
                  : enabledVerbose.push(namespace);
              });
          }

          function namespaceIsEnabled(name) {
            if (!enabledNamespaces.length) return false;

            function matches(namespace) {
              return name.match(new RegExp("^" + namespace + "$"));
            }

            if (disabledNamespaces.some(matches)) return false;
            if (enabledNamespaces.some(matches)) return true;

            return false;
          }

          function namespaceIsVerbose(name) {
            if (!enabledVerbose.length) return false;

            function matches(namespace) {
              return name.match(new RegExp("^" + namespace + "$"));
            }

            if (disabledVerbose.some(matches)) return false;
            if (enabledVerbose.some(matches)) return true;

            return false;
          }

          function timestamp() {
            var now = new Date();

            var time = [
              misc.padStart(now.getHours(), 2, "0"),
              misc.padStart(now.getMinutes(), 2, "0"),
              misc.padStart(now.getSeconds(), 2, "0"),
              misc.padStart(now.getMilliseconds(), 3, "0")
            ];

            return "[" + time.join(":") + "]";
          }

          /**
           * Returns debug fn if debug is enabled, noop if not
           *
           * @param  {string} namespace
           * @return {function}
           */
          module.exports = function debug(namespace) {
            if (!namespaceIsEnabled(namespace)) return noop;

            // shorten Zeroconf:filename.js -> filename… becuase its driving me crazy
            var shortname = namespace.replace("dnssd:", "");
            if (shortname.length > 10) shortname = shortname.substr(0, 9) + "…";
            if (shortname.length < 10) shortname = misc.pad(shortname, 10);

            var color = colors[colorsIndex++ % colors.length];
            var prefix = misc.color("•" + shortname, color);

            function logFn(msg) {
              // '•Query.js [10:41:54:482] '
              var output = prefix + " " + misc.color(timestamp(), "grey") + " ";

              for (
                var _len = arguments.length,
                  args = Array(_len > 1 ? _len - 1 : 0),
                  _key = 1;
                _key < _len;
                _key++
              ) {
                args[_key - 1] = arguments[_key];
              }

              output += misc.format.apply(misc, [msg].concat(args));

              logger(output);
            }

            logFn.isEnabled = true;

            if (namespaceIsVerbose(namespace)) {
              logFn.verbose = logFn;
              logFn.v = logFn;
              logFn.verbose.isEnabled = true;
              logFn.v.isEnabled = true;
            } else {
              logFn.verbose = noop;
              logFn.v = noop;
            }

            return logFn;
          };
        }.call(this, require("_process")));
      },
      { "./misc": 27, _process: 41 }
    ],
    25: [
      function(require, module, exports) {
        "use strict";

        var _typeof =
          typeof Symbol === "function" && typeof Symbol.iterator === "symbol"
            ? function(obj) {
                return typeof obj;
              }
            : function(obj) {
                return obj &&
                  typeof Symbol === "function" &&
                  obj.constructor === Symbol &&
                  obj !== Symbol.prototype
                  ? "symbol"
                  : typeof obj;
              };

        /**
         * Deterministic JSON.stringify for resource record stuff
         *
         * Object keys are sorted so strings are always the same independent of
         * what order properties were added in. Strings are lowercased because
         * record names, TXT keys, SRV target names, etc. need to be compared
         * case-insensitively.
         *
         * @param  {*} val
         * @return {string}
         */
        function stringify(val) {
          if (typeof val === "string") return JSON.stringify(val.toLowerCase());

          if (Array.isArray(val)) return "[" + val.map(stringify) + "]";

          if (
            (typeof val === "undefined" ? "undefined" : _typeof(val)) ===
              "object" &&
            "" + val === "[object Object]"
          ) {
            var str = Object.keys(val)
              .sort()
              .map(function(key) {
                return stringify(key) + ":" + stringify(val[key]);
              })
              .join(",");

            return "{" + str + "}";
          }

          return JSON.stringify(val);
        }

        /**
         * djb2 string hashing function
         *
         * @param  {string} str
         * @return {string} - 32b unsigned hex
         */
        function djb2(str) {
          var hash = 5381;
          var i = str.length;

          // hash stays signed 32b with XOR operator
          while (i) {
            hash = (hash * 33) ^ str.charCodeAt(--i);
          } // coerce to unsigned to get strings without -'s
          return (hash >>> 0).toString(16);
        }

        /**
         * Takes any number of parameters and makes a string hash of them.
         * @return {...*} arguments
         */
        module.exports = function hash() {
          for (
            var _len = arguments.length, args = Array(_len), _key = 0;
            _key < _len;
            _key++
          ) {
            args[_key] = arguments[_key];
          }

          return djb2(stringify(args));
        };
      },
      {}
    ],
    26: [
      function(require, module, exports) {
        "use strict";

        var misc = require("./misc");

        function chunk(arr, size) {
          var i = 0;
          var j = 0;
          var chunked = new Array(Math.ceil(arr.length / size));

          while (i < arr.length) {
            chunked[j++] = arr.slice(i, (i += size));
          }

          return chunked;
        }

        /**
         * Dumps packet buffers to an easier to look at string:
         *
         * XX XX XX XX XX XX XX XX XX XX XX XX XX XX XX XX  ...ascii...!....
         * XX XX XX XX XX XX XX XX XX XX XX XX XX XX XX XX  .asdf...........
         * XX XX XX XX XX XX XX XX XX XX XX XX XX XX XX XX  .........asdf...
         * XX XX XX XX XX XX XX XX XX                       .........
         *
         * DNS name compression pointers shown in magenta
         *
         * @param  {Buffer} buffer
         * @return {string}
         */
        module.exports.view = function view(buffer) {
          // chunk buffer into lines of 16 octets each, like:
          // [
          //  [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16],
          //  [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16],
          //  [1, 2, 3, 4, 5, 6, 7]
          // ]
          var lines = chunk(buffer, 16);

          // keep track of DNS name compression pointers since they are 2 bytes long
          // and we are only looking at 1 byte at a time per line in the loop
          var lastCharacterWasPtr = false;

          // turn each line into a str representation and join with newline
          return lines
            .map(function(octets) {
              var hexChars = [];
              var asciiChars = [];

              // byte by byte marking pointers and ascii chars as they appear
              octets.forEach(function(octet) {
                // individual chars
                var ascii = String.fromCharCode(octet);
                var hex = misc.padStart(octet.toString(16), 2, "0");

                // crazy regex range from ' ' to '~' (printable ascii)
                var isPrintableAscii = /[ -~]/.test(ascii);
                var currentCharIsPtr = octet >= 192;

                // DNS name compression pointers are 2 octets long,
                // and can occur back to back
                if (currentCharIsPtr || lastCharacterWasPtr) {
                  hex = misc.color(hex, "magenta", true);
                  ascii = misc.color(".", "white", true);
                } else if (isPrintableAscii) {
                  hex = misc.color(hex, "blue");
                } else {
                  ascii = misc.color(".", "grey");
                }

                hexChars.push(hex);
                asciiChars.push(ascii);

                lastCharacterWasPtr = currentCharIsPtr;
              });

              // pad with 2 empty spaces so each line is the same length
              // when printed
              while (hexChars.length < 16) {
                hexChars.push("  ");
              } // str representation of this line
              // XX XX XX XX XX XX XX XX XX XX XX XX XX XX XX XX  ...ascii...!....
              return hexChars.join(" ") + "  " + asciiChars.join("");
            })
            .join("\n");
        };
      },
      { "./misc": 27 }
    ],
    27: [
      function(require, module, exports) {
        (function(Buffer) {
          "use strict";

          var _typeof =
            typeof Symbol === "function" && typeof Symbol.iterator === "symbol"
              ? function(obj) {
                  return typeof obj;
                }
              : function(obj) {
                  return obj &&
                    typeof Symbol === "function" &&
                    obj.constructor === Symbol &&
                    obj !== Symbol.prototype
                    ? "symbol"
                    : typeof obj;
                };

          var os = require("os");
          var util = require("util");

          var remove_colors_re = /\x1B\[([0-9]{1,2}(;[0-9]{1,2})?)?[m|K]/g;

          /**
           * Makes a fully qualified domain name from dns labels
           *
           * @param  {...string}
           * @return {string}
           */
          module.exports.fqdn = function() {
            for (
              var _len = arguments.length, labels = Array(_len), _key = 0;
              _key < _len;
              _key++
            ) {
              labels[_key] = arguments[_key];
            }

            var name = labels.join(".");
            return name.substr(-1) === "." ? name : name + ".";
          };

          /**
           * Get hostname. Strips .local if os.hostname includes it
           * @return {string}
           */
          module.exports.hostname = function() {
            return os.hostname().replace(/.local\.?$/, "");
          };

          /**
           * Parses a resource record name into instance, service type, etc
           *
           * Deals with these name formats:
           * -       Instance . _service . _protocol . domain .
           * - Subtype . _sub . _service . _protocol . domain .
           * -                  _service . _protocol . domain .
           * - Single_Label_Host . local .
           *
           * If name fails to parse as expected, it returns an empty obj.
           *
           * @param  {string}
           * @return {object}
           */
          module.exports.parse = function(fullname) {
            var obj = {};

            // a full registration name, eg:
            // - '_http._tcp.local.'
            // - 'Instance No. 1._http._tcp.local.'
            // - 'SubTypeName._sub._http._tcp.local.'
            if (
              !!~fullname.indexOf("._tcp.") ||
              !!~fullname.indexOf("._udp.")
            ) {
              obj.protocol = !!~fullname.indexOf("._tcp.") ? "_tcp" : "_udp";

              // [['Instance No', ' 1', '_http'], [local]]
              var parts = fullname.split(obj.protocol).map(function(part) {
                return part.split(".").filter(function(p) {
                  return !!p;
                });
              });

              obj.domain = parts[1].join("."); // 'local'
              obj.service = parts[0].pop(); // '_http'

              if (parts[0].slice(-1)[0] === "_sub") {
                obj.subtype = parts[0].slice(0, -1).join("."); // 'SubTypeName'
              } else {
                obj.instance = parts[0].join("."); // 'Instance No. 1'
              }

              // a 2 label domain name, eg: 'Machine.Name.local.'
            } else if (fullname.match(/local$|local\.$/)) {
              obj.instance = fullname.split(".local").shift(); // Machine.Name
              obj.domain = "local";
            }

            return obj;
          };

          module.exports.pad = function(value, len) {
            var fill =
              arguments.length > 2 && arguments[2] !== undefined
                ? arguments[2]
                : " ";

            var str = String(value);
            var needed = len - str.length;
            return needed > 0 ? str + fill.repeat(needed) : str;
          };

          module.exports.padStart = function(value, len) {
            var fill =
              arguments.length > 2 && arguments[2] !== undefined
                ? arguments[2]
                : " ";

            var str = String(value);
            var needed = len - str.length;
            return needed > 0 ? fill.repeat(needed) + str : str;
          };

          /**
           * Visually padEnd. Adding colors to strings adds escape sequences that
           * make it a color but also adds characters to str.length that aren't
           * displayed.
           *
           * @param  {string} str
           * @param  {number} num
           * @return {string}
           */
          function visualPad(str, num) {
            var needed = num - str.replace(remove_colors_re, "").length;

            return needed > 0 ? str + " ".repeat(needed) : str;
          }

          /**
           * Make a table of records strings that have equal column lengths.
           *
           * Ex, turn groups of records:
           * [
           *   [
           *     Host.local. * QU,
           *   ]
           *   [
           *     Host.local. A 10 169.254.132.42,
           *     Host.local. AAAA 10 fe80::c17c:ec1c:530d:842a,
           *   ]
           * ]
           *
           * into a more readable form that can be printed:
           * [
           *   [
           *     'Host.local. *    QU'
           *   ]
           *   [
           *     'Host.local. A    10 169.254.132.42'
           *     'Host.local. AAAA 10 fe80::c17c:ec1c:530d:842a'
           *   ]
           * ]
           *
           * @param  {...ResourceRecords[]} groups
           * @return {string[][]}
           */
          function alignRecords() {
            var colWidths = [];
            var result = void 0;

            // Get max size for each column (have to look at all records)

            for (
              var _len2 = arguments.length, groups = Array(_len2), _key2 = 0;
              _key2 < _len2;
              _key2++
            ) {
              groups[_key2] = arguments[_key2];
            }

            result = groups.map(function(records) {
              return records.map(function(record) {
                // break record into parts
                var parts = record.toParts();

                parts.forEach(function(part, i) {
                  var len = part.replace(remove_colors_re, "").length;

                  if (!colWidths[i]) colWidths[i] = 0;
                  if (len > colWidths[i]) colWidths[i] = len;
                });

                return parts;
              });
            });

            // Add padding:
            result = result.map(function(records) {
              return records.map(function(recordParts) {
                return recordParts
                  .map(function(part, i) {
                    return visualPad(part, colWidths[i]);
                  })
                  .join(" ");
              });
            });

            return result;
          }

          module.exports.alignRecords = alignRecords;

          /**
           * Makes a "raw" txt obj for TXT records. A "raw" obj will have string values
           * converted to buffers since TXT key values are just opaque binary data. False
           * values are removed since they aren't sent (missing key = implied false).
           *
           * {key: 'value'} => {'key': <Buffer 76 61 6c 75 65>}
           * {key: true}    => {key: true}
           * {key: null}    => {key: null}
           * {key: false}   => {}
           *
           * @param  {object} obj
           * @return {object} - a new object, original not modified
           */
          module.exports.makeRawTXT = function(obj) {
            var result = {};

            Object.keys(obj)
              .filter(function(key) {
                return obj[key] !== false;
              })
              .forEach(function(key) {
                var value = obj[key];

                result[key] =
                  typeof value === "string"
                    ? Buffer.alloc(value.length, value)
                    : value;
              });

            return result;
          };

          /**
           * Makes a more readable txt obj for TXT records. Buffers are converted to
           * utf8 strings, which is likely what you want anyway.
           *
           * @param  {object} obj
           * @return {object} - a new object, original not modified
           */
          module.exports.makeReadableTXT = function(obj) {
            var result = {};

            Object.keys(obj)
              .filter(function(key) {
                return obj[key] !== false;
              })
              .forEach(function(key) {
                var value = obj[key];
                result[key] = Buffer.isBuffer(value) ? value.toString() : value;
              });

            return result;
          };

          module.exports.defaults = function(obj, defaults) {
            Object.keys(defaults).forEach(function(key) {
              if (!obj.hasOwnProperty(key)) obj[key] = defaults[key];
            });
          };

          module.exports.random = function(min, max) {
            return Math.random() * (max - min) + min;
          };

          module.exports.color = function(str) {
            var color =
              arguments.length > 1 && arguments[1] !== undefined
                ? arguments[1]
                : "white";
            var bright =
              arguments.length > 2 && arguments[2] !== undefined
                ? arguments[2]
                : false;

            var colors = {
              black: 30,
              red: 31,
              green: 32,
              yellow: 33,
              blue: 34,
              magenta: 35,
              cyan: 36,
              white: 37,
              grey: 90 // bright black
            };

            var code = (colors[color] || 37) + (bright ? 60 : 0);

            return "\x1B[" + code + "m" + str + "\x1B[0m";
          };

          module.exports.bg = function(str) {
            var color =
              arguments.length > 1 && arguments[1] !== undefined
                ? arguments[1]
                : "white";
            var bright =
              arguments.length > 2 && arguments[2] !== undefined
                ? arguments[2]
                : false;

            var colors = {
              black: 40,
              red: 41,
              green: 42,
              yellow: 43,
              blue: 44,
              magenta: 45,
              cyan: 46,
              white: 47,
              grey: 100 // bright black
            };

            var code = (colors[color] || 40) + (bright ? 60 : 0);

            return "\x1B[" + code + "m" + str + "\x1B[0m";
          };

          module.exports.truncate = function(str, len) {
            var end =
              arguments.length > 2 && arguments[2] !== undefined
                ? arguments[2]
                : "…";

            return str.length < len ? str : str.slice(0, len) + end;
          };

          function stringify() {
            var arg =
              arguments.length > 0 && arguments[0] !== undefined
                ? arguments[0]
                : "";
            var type =
              arguments.length > 1 && arguments[1] !== undefined
                ? arguments[1]
                : "";

            if (type === "%s" || type === "%d") {
              return String(arg);
            }

            // check that each item has the .toParts() method that misc.alignRecords uses
            // or else it will throw
            if (type === "%r") {
              if (
                Array.isArray(arg) &&
                arg.every(function(record) {
                  return "toParts" in record;
                })
              ) {
                return (
                  "\n" +
                  alignRecords(arg)
                    .map(function(group) {
                      return group.join("\n");
                    })
                    .join("\n")
                );
              }

              return String(arg);
            }

            // util.inspect has pretty colors for objects
            if (
              (typeof arg === "undefined" ? "undefined" : _typeof(arg)) ===
              "object"
            ) {
              var str = util.inspect(arg, { colors: true });
              return str.match("\n") ? "\n" + str + "\n" : str;
            }

            return String(arg);
          }

          module.exports.format = function(msg) {
            for (
              var _len3 = arguments.length,
                args = Array(_len3 > 1 ? _len3 - 1 : 0),
                _key3 = 1;
              _key3 < _len3;
              _key3++
            ) {
              args[_key3 - 1] = arguments[_key3];
            }

            var hasFormatters = typeof msg === "string" && msg.match(/%[a-z]/);

            // replace each format marker in message string with the formatted arg
            // (or just add formatted message to output if no args)
            var output =
              hasFormatters && args.length
                ? msg.replace(/%([a-z])/g, function(type) {
                    return stringify(args.shift(), type);
                  })
                : stringify(msg);

            // add padding for printing surplus args left over
            if (args.length) output += " ";

            // print args that didn't have a formatter
            output += args
              .map(function(arg) {
                return stringify(arg);
              })
              .join(" ");

            // remove hanging newline at end and add indentation
            output = output.replace(/\n$/, "");
            output = output.replace(/\n/g, "\n    ");

            return output;
          };

          /**
           * Map fn() n times
           */
          module.exports.map_n = function(fn, n) {
            var results = [];

            for (var i = 0; i < n; i++) {
              results.push(fn());
            }

            return results;
          };

          /**
           * Call fn after n calls
           */
          module.exports.after_n = function(fn, n) {
            var count = n;

            return function() {
              count--;
              if (count <= 0) return fn.apply(undefined, arguments);
            };
          };

          /**
           * Deep equality check
           */
          module.exports.equals = function equals(a, b) {
            if (a === b) return true;
            if (typeof a !== "undefined" && typeof b === "undefined")
              return false;
            if (typeof a === "undefined" && typeof b !== "undefined")
              return false;

            if (Array.isArray(a) !== Array.isArray(b)) {
              return false;
            }

            if (Array.isArray(a) && Array.isArray(b)) {
              if (a.length !== b.length) return false;

              for (var i = 0; i < a.length; i++) {
                if (!equals(a[i], b[i])) return false;
              }

              return true;
            }

            if (a instanceof Object && b instanceof Object) {
              var a_keys = Object.keys(a);
              var b_keys = Object.keys(b);

              if (a_keys.length !== b_keys.length) {
                return false;
              }

              return a_keys.every(function(key) {
                return equals(a[key], b[key]);
              });
            }

            return false;
          };
        }.call(this, require("buffer").Buffer));
      },
      { buffer: 36, os: 39, util: 45 }
    ],
    28: [
      function(require, module, exports) {
        (function(__filename) {
          "use strict";

          var _typeof =
            typeof Symbol === "function" && typeof Symbol.iterator === "symbol"
              ? function(obj) {
                  return typeof obj;
                }
              : function(obj) {
                  return obj &&
                    typeof Symbol === "function" &&
                    obj.constructor === Symbol &&
                    obj !== Symbol.prototype
                    ? "symbol"
                    : typeof obj;
                };

          var Query = require("./Query");
          var ServiceResolver = require("./ServiceResolver");
          var DisposableInterface = require("./DisposableInterface");

          var EventEmitter = require("./EventEmitter");
          var ValidationError = require("./customError").create(
            "ValidationError"
          );

          var filename = require("path").basename(__filename);
          var debug = require("./debug")("dnssd:" + filename);

          var RType = require("./constants").RType;

          function runQuery(name, qtype) {
            var options =
              arguments.length > 2 && arguments[2] !== undefined
                ? arguments[2]
                : {};

            debug("Resolving " + name + ", type: " + qtype);

            var timeout = options.timeout || 2000;
            var question = { name: name, qtype: qtype };

            var intf = DisposableInterface.create(options.interface);
            var killswitch = new EventEmitter();

            return new Promise(function(resolve, reject) {
              function stop() {
                killswitch.emit("stop");
                intf.stop();
              }

              function sendQuery() {
                new Query(intf, killswitch)
                  .continuous(false)
                  .setTimeout(timeout)
                  .add(question)
                  .once("answer", function(answer, related) {
                    stop();
                    resolve({ answer: answer, related: related });
                  })
                  .once("timeout", function() {
                    stop();
                    reject(new Error("Resolve query timed out"));
                  })
                  .start();
              }

              intf
                .bind()
                .then(sendQuery)
                .catch(reject);
            });
          }

          function resolveAny(name, type) {
            var options =
              arguments.length > 2 && arguments[2] !== undefined
                ? arguments[2]
                : {};

            var qtype = void 0;

            if (typeof name !== "string") {
              throw new ValidationError(
                "Name must be a string, got %s",
                typeof name === "undefined" ? "undefined" : _typeof(name)
              );
            }

            if (!name.length) {
              throw new ValidationError("Name can't be empty");
            }

            if (typeof type === "string") qtype = RType[type.toUpperCase()];
            if (Number.isInteger(type)) qtype = type;

            if (!qtype || qtype <= 0 || qtype > 0xffff) {
              throw new ValidationError('Unknown query type, got "%s"', type);
            }

            if (
              (typeof options === "undefined"
                ? "undefined"
                : _typeof(options)) !== "object"
            ) {
              throw new ValidationError(
                "Options must be an object, got %s",
                typeof options === "undefined" ? "undefined" : _typeof(options)
              );
            }

            if (
              options.interface &&
              !DisposableInterface.isValidName(options.interface)
            ) {
              throw new ValidationError(
                'Interface "' + options.interface + "\" doesn't exist"
              );
            }

            if (name.substr(-1) !== ".") name += "."; // make sure root label exists

            return runQuery(name, qtype, options);
          }

          function resolve4(name, opts) {
            return resolveAny(name, "A", opts).then(function(result) {
              return result.answer.address;
            });
          }

          function resolve6(name, opts) {
            return resolveAny(name, "AAAA", opts).then(function(result) {
              return result.answer.address;
            });
          }

          function resolveSRV(name, opts) {
            return resolveAny(name, "SRV", opts).then(function(result) {
              return { target: result.answer.target, port: result.answer.port };
            });
          }

          function resolveTXT(name, opts) {
            return resolveAny(name, "TXT", opts).then(function(result) {
              return { txt: result.answer.txt, txtRaw: result.answer.txtRaw };
            });
          }

          function resolveService(name) {
            var options =
              arguments.length > 1 && arguments[1] !== undefined
                ? arguments[1]
                : {};

            debug("Resolving service: " + name);

            var timeout = options.timeout || 2000;

            if (typeof name !== "string") {
              throw new ValidationError(
                "Name must be a string, got %s",
                typeof name === "undefined" ? "undefined" : _typeof(name)
              );
            }

            if (!name.length) {
              throw new ValidationError("Name can't be empty");
            }

            if (
              (typeof options === "undefined"
                ? "undefined"
                : _typeof(options)) !== "object"
            ) {
              throw new ValidationError(
                "Options must be an object, got %s",
                typeof options === "undefined" ? "undefined" : _typeof(options)
              );
            }

            if (
              options.interface &&
              !DisposableInterface.isValidName(options.interface)
            ) {
              throw new ValidationError(
                'Interface "' + options.interface + "\" doesn't exist"
              );
            }

            if (name.substr(-1) !== ".") name += "."; // make sure root label exists

            var intf = DisposableInterface.create(options.interface);
            var resolver = new ServiceResolver(name, intf);

            function stop() {
              resolver.stop();
              intf.stop();
            }

            function startResolver() {
              return new Promise(function(resolve, reject) {
                var timer = setTimeout(function() {
                  reject(new Error("Resolve service timed out"));
                  stop();
                }, timeout);

                resolver.once("resolved", function() {
                  resolve(resolver.service());
                  stop();
                  clearTimeout(timer);
                });

                resolver.start();
              });
            }

            return intf.bind().then(startResolver);
          }

          module.exports = {
            resolve: resolveAny,
            resolve4: resolve4,
            resolve6: resolve6,
            resolveSRV: resolveSRV,
            resolveTXT: resolveTXT,
            resolveService: resolveService
          };
        }.call(this, "/../dnssd.js/lib/resolve.js"));
      },
      {
        "./DisposableInterface": 5,
        "./EventEmitter": 6,
        "./Query": 12,
        "./ServiceResolver": 18,
        "./constants": 22,
        "./customError": 23,
        "./debug": 24,
        path: 40
      }
    ],
    29: [
      function(require, module, exports) {
        "use strict";
        var timers = require("timers");

        var setTimeout = timers.setTimeout,
          clearTimeout = timers.clearTimeout,
          setInterval = timers.setInterval,
          clearInterval = timers.clearInterval,
          setImmediate = timers.setImmediate,
          clearImmediate = timers.clearImmediate;

        // Periodically checks for sleep. The interval timer should fire within
        // expected range. If it fires later than  expected, it's probably because
        // it's coming back from sleep.

        var EventEmitter = require("./EventEmitter");

        var sleep = new EventEmitter();
        var frequency = 60 * 1000; // check for sleep once a minute
        var fudge = 5 * 1000;
        var last = Date.now();

        var interval = setInterval(function checkSleep() {
          var now = Date.now();
          var expected = last + frequency;
          last = now;

          if (now > expected + fudge) sleep.emit("wake");
        }, frequency);

        // don't hold up the process
        interval.unref();

        module.exports = sleep;
      },
      { "./EventEmitter": 6, timers: 42 }
    ],
    30: [
      function(require, module, exports) {
        (function(Buffer) {
          "use strict";

          var _typeof =
            typeof Symbol === "function" && typeof Symbol.iterator === "symbol"
              ? function(obj) {
                  return typeof obj;
                }
              : function(obj) {
                  return obj &&
                    typeof Symbol === "function" &&
                    obj.constructor === Symbol &&
                    obj !== Symbol.prototype
                    ? "symbol"
                    : typeof obj;
                };

          var ValidationError = require("./customError").create(
            "ValidationError"
          );

          function isNumeric(value) {
            return !Number.isNaN(parseFloat(value)) && Number.isFinite(value);
          }

          /**
           * Exported
           */
          var validate = (module.exports = {});

          /**
           * Validates a transport protocol, throws err on invalid input
           * @param {string} str
           */
          validate.protocol = function protocol(str) {
            if (typeof str !== "string") {
              throw new ValidationError(
                "Protocol must be a string, got %s",
                typeof str === "undefined" ? "undefined" : _typeof(str)
              );
            }

            if (str === "" || (str !== "_tcp" && str !== "_udp")) {
              throw new ValidationError(
                "Protocol must be _tcp or _udp, got '%s'",
                str
              );
            }
          };

          /**
           * Validates a service name, throws err on invalid input
           * @param {string} str
           */
          validate.serviceName = function serviceName(str) {
            if (typeof str !== "string") {
              throw new ValidationError(
                "Service name must be a string, got %s",
                typeof str === "undefined" ? "undefined" : _typeof(str)
              );
            }

            if (!str) {
              throw new ValidationError(
                "Service name can't be an empty string"
              );
            }

            if (!/^_/.test(str)) {
              throw new ValidationError(
                "Service '%s' must start with '_'",
                str
              );
            }

            // 15 bytes not including the leading underscore
            if (Buffer.byteLength(str) > 16) {
              throw new ValidationError("Service '%s' is > 15 bytes", str);
            }

            if (!/^_[A-Za-z0-9]/.test(str) || !/[A-Za-z0-9]*$/.test(str)) {
              throw new ValidationError(
                "Service '%s' must start and end with a letter or digit",
                str
              );
            }

            if (!/^_[A-Za-z0-9-]+$/.test(str)) {
              throw new ValidationError(
                "Service '%s' should be only letters, digits, and hyphens",
                str
              );
            }

            if (/--/.test(str)) {
              throw new ValidationError(
                "Service '%s' must not have consecutive hyphens",
                str
              );
            }

            if (!/[A-Za-z]/.test(str)) {
              throw new ValidationError(
                "Service '%s' must have at least 1 letter",
                str
              );
            }
          };

          /**
           * Validates a dns label, throws err on invalid input
           *
           * @param {string} str - label to validate
           * @param {string} [name] - name of the label (for better error messages)
           */
          validate.label = function label(str) {
            var name =
              arguments.length > 1 && arguments[1] !== undefined
                ? arguments[1]
                : "label";

            if (typeof str !== "string") {
              throw new ValidationError(
                "%s name must be a string, got %s",
                name,
                typeof str === "undefined" ? "undefined" : _typeof(str)
              );
            }

            if (!str) {
              throw new ValidationError(
                "%s name can't be an empty string",
                name
              );
            }

            if (/[\x00-\x1F]|\x7F/.test(str)) {
              throw new ValidationError(
                "%s name '%s' can't contain control chars",
                name,
                str
              );
            }

            if (Buffer.byteLength(str) > 63) {
              throw new ValidationError(
                "%s must be <= 63 bytes. %s is %d",
                name,
                str,
                Buffer.byteLength(str)
              );
            }
          };

          /**
           * Validates a port, throws err on invalid input
           *
           * @param {integer} num
           */
          validate.port = function port(num) {
            if (!Number.isInteger(num) || num <= 0 || num > 0xffff) {
              throw new ValidationError(
                "Port must be an integer between 0 and 65535, got %s",
                num
              );
            }
          };

          /**
           * Validates rdata for a TXT record, throws err on invalid input
           *
           * Example of a valid txt object:
           * {
           *   key: 'value',
           *   buf: Buffer.alloc(123)
           * }
           *
           * @param {object} obj
           */
          validate.txt = function txt(obj) {
            var sizeTotal = 0;
            var keys = new Set();

            if (
              (typeof obj === "undefined" ? "undefined" : _typeof(obj)) !==
              "object"
            ) {
              throw new ValidationError("TXT must be an object");
            }

            // validate each key value pair
            Object.keys(obj).forEach(function(key) {
              var value = obj[key];
              var size = Buffer.byteLength(key);

              // keys
              if (Buffer.byteLength(key) > 9) {
                throw new ValidationError("Key '%s' in TXT is > 9 chars", key);
              }

              if (!!~key.indexOf("=")) {
                throw new ValidationError(
                  "Key '%s' in TXT contains a '='",
                  key
                );
              }

              if (!/^[ -~]*$/.test(key)) {
                throw new ValidationError(
                  "Key '%s' in TXT is not printable ascii",
                  key
                );
              }

              if (keys.has(key.toLowerCase())) {
                throw new ValidationError(
                  "Key '%s' in TXT occurs more than once. (case insensitive)",
                  key
                );
              }

              keys.add(key.toLowerCase());

              // value type
              if (
                typeof value !== "string" &&
                typeof value !== "boolean" &&
                !isNumeric(value) &&
                !Buffer.isBuffer(value)
              ) {
                throw new ValidationError(
                  "TXT values must be a string, buffer, number, or boolean. got %s",
                  typeof value === "undefined" ? "undefined" : _typeof(value)
                );
              }

              // size limits
              if (typeof value !== "boolean") {
                size += Buffer.isBuffer(value)
                  ? value.length
                  : Buffer.byteLength(value.toString());

                // add 1 for the '=' in 'key=value'
                // add 1 for the length byte to be written before 'key=value'
                size += 2;
              }

              sizeTotal += size;

              if (size > 255) {
                throw new ValidationError(
                  "Each key/value in TXT must be < 255 bytes"
                );
              }

              if (sizeTotal > 1300) {
                throw new ValidationError("TXT record is > 1300 bytes.");
              }
            });
          };
        }.call(this, require("buffer").Buffer));
      },
      { "./customError": 23, buffer: 36 }
    ],
    31: [
      function(require, module, exports) {
        module.exports = require("simudp");
      },
      { simudp: 32 }
    ],
    32: [
      function(require, module, exports) {
        var util = require("util");
        var events = require("events");
        var io = require("socket.io-client");
        var Buffer = require("buffer").Buffer;

        function Socket(type, listener, host, io_options) {
          events.EventEmitter.call(this);

          //init state variables
          this._listening = false;
          this._binding = false;

          //type of socket 'udp4', 'udp6', 'unix_socket'
          this.type = type || "udp4";

          //listener
          if (typeof listener === "function") this.on("message", listener);

          //args swap
          if (typeof listener === "string") {
            host = listener;
            io_options = host;
          }

          io_options = io_options || {};

          //alows muliple socket on one browser
          io_options["force new connection"] = true;

          //use sio manespaceing
          host = (host || "") + "/simudp";

          //connect socket.io
          this.sio = io.connect(host, io_options);
        }
        util.inherits(Socket, events.EventEmitter);

        exports.Socket = Socket;
        exports.createSocket = function(type, listener) {
          return new Socket(type, listener);
        };

        Socket.prototype.bind = function(port, address) {
          var self = this;

          if (this._listening) throw new Error("already listening");

          if (this._binding) throw new Error("already binding");

          this._binding = true;

          this.sio.emit("bind", {
            type: this.type,
            port: port,
            address: address
          });

          this.sio.on("listening", function(address) {
            //set address
            self._address = address;

            self._binding = false;
            self._listening = true;

            self.emit("listening");

            //proxy incoming messages
            self.sio.on("dgram-message", function(message) {
              self.emit(
                "message",
                new Buffer(message.msg, "ascii"),
                message.rinfo
              );
            });

            //proxy error
            self.sio.on("error", function(error) {
              self.emit("error", error);
            });

            //disconnection
            self.sio.on("disconnect", function() {
              self.emit("close");
              self.removeAllListeners();
            });
          });
        };

        Socket.prototype.send = function(
          buffer,
          offset,
          length,
          port,
          address,
          callback
        ) {
          var self = this;

          //we are not listening : bind and then send when listening
          if (!this._listening) {
            if (!this._binding) this.bind();

            var _args = arguments;
            this.once("listening", function() {
              self.send.apply(self, _args);
            });
            return;
          }

          //accept buffer as string
          buffer = typeof buffer === "string" ? new Buffer(buffer) : buffer;

          //emit directly exception if any
          if (offset >= buffer.length)
            throw new Error("Offset into buffer too large");
          if (offset + length > buffer.length)
            throw new Error("Offset + length beyond buffer length");

          //send it on wire
          this.sio.emit("dgram-message", {
            buffer: buffer.toString("ascii"),
            offset: offset,
            length: length,
            port: port,
            address: address
          });

          if (callback) callback.call(null);
        };

        Socket.prototype.close = function() {
          this.sio.disconnect();
          this.emit("close");
          this.removeAllListeners();
        };

        Socket.prototype.address = function() {
          if (!this._address) throw new Error("not binded");

          return this._address;
        };

        // not implemented methods

        Socket.prototype.setBroadcast = function(arg) {
          throw new Error("not implemented");
        };

        Socket.prototype.setTTL = function(arg) {
          throw new Error("not implemented");
        };

        Socket.prototype.setMulticastTTL = function(arg) {
          throw new Error("not implemented");
        };

        Socket.prototype.setMulticastLoopback = function(arg) {
          throw new Error("not implemented");
        };

        Socket.prototype.addMembership = function(
          multicastAddress,
          nterfaceAddress
        ) {
          throw new Error("not implemented");
        };

        Socket.prototype.dropMembership = function(
          multicastAddress,
          interfaceAddress
        ) {
          throw new Error("not implemented");
        };
      },
      { buffer: 36, events: 37, "socket.io-client": 33, util: 45 }
    ],
    33: [
      function(require, module, exports) {
        /*! Socket.IO.js build:0.9.17, development. Copyright(c) 2011 LearnBoost <dev@learnboost.com> MIT Licensed */

        var io = "undefined" === typeof module ? {} : module.exports;
        (function() {
          /**
           * socket.io
           * Copyright(c) 2011 LearnBoost <dev@learnboost.com>
           * MIT Licensed
           */

          (function(exports, global) {
            /**
             * IO namespace.
             *
             * @namespace
             */

            var io = exports;

            /**
             * Socket.IO version
             *
             * @api public
             */

            io.version = "0.9.17";

            /**
             * Protocol implemented.
             *
             * @api public
             */

            io.protocol = 1;

            /**
             * Available transports, these will be populated with the available transports
             *
             * @api public
             */

            io.transports = [];

            /**
             * Keep track of jsonp callbacks.
             *
             * @api private
             */

            io.j = [];

            /**
             * Keep track of our io.Sockets
             *
             * @api private
             */
            io.sockets = {};

            /**
             * Manages connections to hosts.
             *
             * @param {String} uri
             * @Param {Boolean} force creation of new socket (defaults to false)
             * @api public
             */

            io.connect = function(host, details) {
              var uri = io.util.parseUri(host),
                uuri,
                socket;

              if (global && global.location) {
                uri.protocol =
                  uri.protocol || global.location.protocol.slice(0, -1);
                uri.host =
                  uri.host ||
                  (global.document
                    ? global.document.domain
                    : global.location.hostname);
                uri.port = uri.port || global.location.port;
              }

              uuri = io.util.uniqueUri(uri);

              var options = {
                host: uri.host,
                secure: "https" == uri.protocol,
                port: uri.port || ("https" == uri.protocol ? 443 : 80),
                query: uri.query || ""
              };

              io.util.merge(options, details);

              if (options["force new connection"] || !io.sockets[uuri]) {
                socket = new io.Socket(options);
              }

              if (!options["force new connection"] && socket) {
                io.sockets[uuri] = socket;
              }

              socket = socket || io.sockets[uuri];

              // if path is different from '' or /
              return socket.of(uri.path.length > 1 ? uri.path : "");
            };
          })(
            "object" === typeof module ? module.exports : (this.io = {}),
            this
          );
          /**
           * socket.io
           * Copyright(c) 2011 LearnBoost <dev@learnboost.com>
           * MIT Licensed
           */

          (function(exports, global) {
            /**
             * Utilities namespace.
             *
             * @namespace
             */

            var util = (exports.util = {});

            /**
             * Parses an URI
             *
             * @author Steven Levithan <stevenlevithan.com> (MIT license)
             * @api public
             */

            var re = /^(?:(?![^:@]+:[^:@\/]*@)([^:\/?#.]+):)?(?:\/\/)?((?:(([^:@]*)(?::([^:@]*))?)?@)?([^:\/?#]*)(?::(\d*))?)(((\/(?:[^?#](?![^?#\/]*\.[^?#\/.]+(?:[?#]|$)))*\/?)?([^?#\/]*))(?:\?([^#]*))?(?:#(.*))?)/;

            var parts = [
              "source",
              "protocol",
              "authority",
              "userInfo",
              "user",
              "password",
              "host",
              "port",
              "relative",
              "path",
              "directory",
              "file",
              "query",
              "anchor"
            ];

            util.parseUri = function(str) {
              var m = re.exec(str || ""),
                uri = {},
                i = 14;

              while (i--) {
                uri[parts[i]] = m[i] || "";
              }

              return uri;
            };

            /**
             * Produces a unique url that identifies a Socket.IO connection.
             *
             * @param {Object} uri
             * @api public
             */

            util.uniqueUri = function(uri) {
              var protocol = uri.protocol,
                host = uri.host,
                port = uri.port;

              if ("document" in global) {
                host = host || document.domain;
                port =
                  port ||
                  (protocol == "https" &&
                  document.location.protocol !== "https:"
                    ? 443
                    : document.location.port);
              } else {
                host = host || "localhost";

                if (!port && protocol == "https") {
                  port = 443;
                }
              }

              return (protocol || "http") + "://" + host + ":" + (port || 80);
            };

            /**
             * Mergest 2 query strings in to once unique query string
             *
             * @param {String} base
             * @param {String} addition
             * @api public
             */

            util.query = function(base, addition) {
              var query = util.chunkQuery(base || ""),
                components = [];

              util.merge(query, util.chunkQuery(addition || ""));
              for (var part in query) {
                if (query.hasOwnProperty(part)) {
                  components.push(part + "=" + query[part]);
                }
              }

              return components.length ? "?" + components.join("&") : "";
            };

            /**
             * Transforms a querystring in to an object
             *
             * @param {String} qs
             * @api public
             */

            util.chunkQuery = function(qs) {
              var query = {},
                params = qs.split("&"),
                i = 0,
                l = params.length,
                kv;

              for (; i < l; ++i) {
                kv = params[i].split("=");
                if (kv[0]) {
                  query[kv[0]] = kv[1];
                }
              }

              return query;
            };

            /**
             * Executes the given function when the page is loaded.
             *
             *     io.util.load(function () { console.log('page loaded'); });
             *
             * @param {Function} fn
             * @api public
             */

            var pageLoaded = false;

            util.load = function(fn) {
              if (
                ("document" in global && document.readyState === "complete") ||
                pageLoaded
              ) {
                return fn();
              }

              util.on(global, "load", fn, false);
            };

            /**
             * Adds an event.
             *
             * @api private
             */

            util.on = function(element, event, fn, capture) {
              if (element.attachEvent) {
                element.attachEvent("on" + event, fn);
              } else if (element.addEventListener) {
                element.addEventListener(event, fn, capture);
              }
            };

            /**
             * Generates the correct `XMLHttpRequest` for regular and cross domain requests.
             *
             * @param {Boolean} [xdomain] Create a request that can be used cross domain.
             * @returns {XMLHttpRequest|false} If we can create a XMLHttpRequest.
             * @api private
             */

            util.request = function(xdomain) {
              if (
                xdomain &&
                "undefined" != typeof XDomainRequest &&
                !util.ua.hasCORS
              ) {
                return new XDomainRequest();
              }

              if (
                "undefined" != typeof XMLHttpRequest &&
                (!xdomain || util.ua.hasCORS)
              ) {
                return new XMLHttpRequest();
              }

              if (!xdomain) {
                try {
                  return new window[["Active"].concat("Object").join("X")](
                    "Microsoft.XMLHTTP"
                  );
                } catch (e) {}
              }

              return null;
            };

            /**
             * XHR based transport constructor.
             *
             * @constructor
             * @api public
             */

            /**
             * Change the internal pageLoaded value.
             */

            if ("undefined" != typeof window) {
              util.load(function() {
                pageLoaded = true;
              });
            }

            /**
             * Defers a function to ensure a spinner is not displayed by the browser
             *
             * @param {Function} fn
             * @api public
             */

            util.defer = function(fn) {
              if (!util.ua.webkit || "undefined" != typeof importScripts) {
                return fn();
              }

              util.load(function() {
                setTimeout(fn, 100);
              });
            };

            /**
             * Merges two objects.
             *
             * @api public
             */

            util.merge = function merge(target, additional, deep, lastseen) {
              var seen = lastseen || [],
                depth = typeof deep == "undefined" ? 2 : deep,
                prop;

              for (prop in additional) {
                if (
                  additional.hasOwnProperty(prop) &&
                  util.indexOf(seen, prop) < 0
                ) {
                  if (typeof target[prop] !== "object" || !depth) {
                    target[prop] = additional[prop];
                    seen.push(additional[prop]);
                  } else {
                    util.merge(target[prop], additional[prop], depth - 1, seen);
                  }
                }
              }

              return target;
            };

            /**
             * Merges prototypes from objects
             *
             * @api public
             */

            util.mixin = function(ctor, ctor2) {
              util.merge(ctor.prototype, ctor2.prototype);
            };

            /**
             * Shortcut for prototypical and static inheritance.
             *
             * @api private
             */

            util.inherit = function(ctor, ctor2) {
              function f() {}
              f.prototype = ctor2.prototype;
              ctor.prototype = new f();
            };

            /**
             * Checks if the given object is an Array.
             *
             *     io.util.isArray([]); // true
             *     io.util.isArray({}); // false
             *
             * @param Object obj
             * @api public
             */

            util.isArray =
              Array.isArray ||
              function(obj) {
                return Object.prototype.toString.call(obj) === "[object Array]";
              };

            /**
             * Intersects values of two arrays into a third
             *
             * @api public
             */

            util.intersect = function(arr, arr2) {
              var ret = [],
                longest = arr.length > arr2.length ? arr : arr2,
                shortest = arr.length > arr2.length ? arr2 : arr;

              for (var i = 0, l = shortest.length; i < l; i++) {
                if (~util.indexOf(longest, shortest[i])) ret.push(shortest[i]);
              }

              return ret;
            };

            /**
             * Array indexOf compatibility.
             *
             * @see bit.ly/a5Dxa2
             * @api public
             */

            util.indexOf = function(arr, o, i) {
              for (
                var j = arr.length,
                  i = i < 0 ? (i + j < 0 ? 0 : i + j) : i || 0;
                i < j && arr[i] !== o;
                i++
              ) {}

              return j <= i ? -1 : i;
            };

            /**
             * Converts enumerables to array.
             *
             * @api public
             */

            util.toArray = function(enu) {
              var arr = [];

              for (var i = 0, l = enu.length; i < l; i++) arr.push(enu[i]);

              return arr;
            };

            /**
             * UA / engines detection namespace.
             *
             * @namespace
             */

            util.ua = {};

            /**
             * Whether the UA supports CORS for XHR.
             *
             * @api public
             */

            util.ua.hasCORS =
              "undefined" != typeof XMLHttpRequest &&
              (function() {
                try {
                  var a = new XMLHttpRequest();
                } catch (e) {
                  return false;
                }

                return a.withCredentials != undefined;
              })();

            /**
             * Detect webkit.
             *
             * @api public
             */

            util.ua.webkit =
              "undefined" != typeof navigator &&
              /webkit/i.test(navigator.userAgent);

            /**
             * Detect iPad/iPhone/iPod.
             *
             * @api public
             */

            util.ua.iDevice =
              "undefined" != typeof navigator &&
              /iPad|iPhone|iPod/i.test(navigator.userAgent);
          })("undefined" != typeof io ? io : module.exports, this);
          /**
           * socket.io
           * Copyright(c) 2011 LearnBoost <dev@learnboost.com>
           * MIT Licensed
           */

          (function(exports, io) {
            /**
             * Expose constructor.
             */

            exports.EventEmitter = EventEmitter;

            /**
             * Event emitter constructor.
             *
             * @api public.
             */

            function EventEmitter() {}

            /**
             * Adds a listener
             *
             * @api public
             */

            EventEmitter.prototype.on = function(name, fn) {
              if (!this.$events) {
                this.$events = {};
              }

              if (!this.$events[name]) {
                this.$events[name] = fn;
              } else if (io.util.isArray(this.$events[name])) {
                this.$events[name].push(fn);
              } else {
                this.$events[name] = [this.$events[name], fn];
              }

              return this;
            };

            EventEmitter.prototype.addListener = EventEmitter.prototype.on;

            /**
             * Adds a volatile listener.
             *
             * @api public
             */

            EventEmitter.prototype.once = function(name, fn) {
              var self = this;

              function on() {
                self.removeListener(name, on);
                fn.apply(this, arguments);
              }

              on.listener = fn;
              this.on(name, on);

              return this;
            };

            /**
             * Removes a listener.
             *
             * @api public
             */

            EventEmitter.prototype.removeListener = function(name, fn) {
              if (this.$events && this.$events[name]) {
                var list = this.$events[name];

                if (io.util.isArray(list)) {
                  var pos = -1;

                  for (var i = 0, l = list.length; i < l; i++) {
                    if (
                      list[i] === fn ||
                      (list[i].listener && list[i].listener === fn)
                    ) {
                      pos = i;
                      break;
                    }
                  }

                  if (pos < 0) {
                    return this;
                  }

                  list.splice(pos, 1);

                  if (!list.length) {
                    delete this.$events[name];
                  }
                } else if (
                  list === fn ||
                  (list.listener && list.listener === fn)
                ) {
                  delete this.$events[name];
                }
              }

              return this;
            };

            /**
             * Removes all listeners for an event.
             *
             * @api public
             */

            EventEmitter.prototype.removeAllListeners = function(name) {
              if (name === undefined) {
                this.$events = {};
                return this;
              }

              if (this.$events && this.$events[name]) {
                this.$events[name] = null;
              }

              return this;
            };

            /**
             * Gets all listeners for a certain event.
             *
             * @api publci
             */

            EventEmitter.prototype.listeners = function(name) {
              if (!this.$events) {
                this.$events = {};
              }

              if (!this.$events[name]) {
                this.$events[name] = [];
              }

              if (!io.util.isArray(this.$events[name])) {
                this.$events[name] = [this.$events[name]];
              }

              return this.$events[name];
            };

            /**
             * Emits an event.
             *
             * @api public
             */

            EventEmitter.prototype.emit = function(name) {
              if (!this.$events) {
                return false;
              }

              var handler = this.$events[name];

              if (!handler) {
                return false;
              }

              var args = Array.prototype.slice.call(arguments, 1);

              if ("function" == typeof handler) {
                handler.apply(this, args);
              } else if (io.util.isArray(handler)) {
                var listeners = handler.slice();

                for (var i = 0, l = listeners.length; i < l; i++) {
                  listeners[i].apply(this, args);
                }
              } else {
                return false;
              }

              return true;
            };
          })(
            "undefined" != typeof io ? io : module.exports,
            "undefined" != typeof io ? io : module.parent.exports
          );

          /**
           * socket.io
           * Copyright(c) 2011 LearnBoost <dev@learnboost.com>
           * MIT Licensed
           */

          /**
           * Based on JSON2 (http://www.JSON.org/js.html).
           */

          (function(exports, nativeJSON) {
            "use strict";

            // use native JSON if it's available
            if (nativeJSON && nativeJSON.parse) {
              return (exports.JSON = {
                parse: nativeJSON.parse,
                stringify: nativeJSON.stringify
              });
            }

            var JSON = (exports.JSON = {});

            function f(n) {
              // Format integers to have at least two digits.
              return n < 10 ? "0" + n : n;
            }

            function date(d, key) {
              return isFinite(d.valueOf())
                ? d.getUTCFullYear() +
                    "-" +
                    f(d.getUTCMonth() + 1) +
                    "-" +
                    f(d.getUTCDate()) +
                    "T" +
                    f(d.getUTCHours()) +
                    ":" +
                    f(d.getUTCMinutes()) +
                    ":" +
                    f(d.getUTCSeconds()) +
                    "Z"
                : null;
            }

            var cx = /[\u0000\u00ad\u0600-\u0604\u070f\u17b4\u17b5\u200c-\u200f\u2028-\u202f\u2060-\u206f\ufeff\ufff0-\uffff]/g,
              escapable = /[\\\"\x00-\x1f\x7f-\x9f\u00ad\u0600-\u0604\u070f\u17b4\u17b5\u200c-\u200f\u2028-\u202f\u2060-\u206f\ufeff\ufff0-\uffff]/g,
              gap,
              indent,
              meta = {
                // table of character substitutions
                "\b": "\\b",
                "\t": "\\t",
                "\n": "\\n",
                "\f": "\\f",
                "\r": "\\r",
                '"': '\\"',
                "\\": "\\\\"
              },
              rep;

            function quote(string) {
              // If the string contains no control characters, no quote characters, and no
              // backslash characters, then we can safely slap some quotes around it.
              // Otherwise we must also replace the offending characters with safe escape
              // sequences.

              escapable.lastIndex = 0;
              return escapable.test(string)
                ? '"' +
                    string.replace(escapable, function(a) {
                      var c = meta[a];
                      return typeof c === "string"
                        ? c
                        : "\\u" +
                            ("0000" + a.charCodeAt(0).toString(16)).slice(-4);
                    }) +
                    '"'
                : '"' + string + '"';
            }

            function str(key, holder) {
              // Produce a string from holder[key].

              var i, // The loop counter.
                k, // The member key.
                v, // The member value.
                length,
                mind = gap,
                partial,
                value = holder[key];

              // If the value has a toJSON method, call it to obtain a replacement value.

              if (value instanceof Date) {
                value = date(key);
              }

              // If we were called with a replacer function, then call the replacer to
              // obtain a replacement value.

              if (typeof rep === "function") {
                value = rep.call(holder, key, value);
              }

              // What happens next depends on the value's type.

              switch (typeof value) {
                case "string":
                  return quote(value);

                case "number":
                  // JSON numbers must be finite. Encode non-finite numbers as null.

                  return isFinite(value) ? String(value) : "null";

                case "boolean":
                case "null":
                  // If the value is a boolean or null, convert it to a string. Note:
                  // typeof null does not produce 'null'. The case is included here in
                  // the remote chance that this gets fixed someday.

                  return String(value);

                // If the type is 'object', we might be dealing with an object or an array or
                // null.

                case "object":
                  // Due to a specification blunder in ECMAScript, typeof null is 'object',
                  // so watch out for that case.

                  if (!value) {
                    return "null";
                  }

                  // Make an array to hold the partial results of stringifying this object value.

                  gap += indent;
                  partial = [];

                  // Is the value an array?

                  if (
                    Object.prototype.toString.apply(value) === "[object Array]"
                  ) {
                    // The value is an array. Stringify every element. Use null as a placeholder
                    // for non-JSON values.

                    length = value.length;
                    for (i = 0; i < length; i += 1) {
                      partial[i] = str(i, value) || "null";
                    }

                    // Join all of the elements together, separated with commas, and wrap them in
                    // brackets.

                    v =
                      partial.length === 0
                        ? "[]"
                        : gap
                        ? "[\n" +
                          gap +
                          partial.join(",\n" + gap) +
                          "\n" +
                          mind +
                          "]"
                        : "[" + partial.join(",") + "]";
                    gap = mind;
                    return v;
                  }

                  // If the replacer is an array, use it to select the members to be stringified.

                  if (rep && typeof rep === "object") {
                    length = rep.length;
                    for (i = 0; i < length; i += 1) {
                      if (typeof rep[i] === "string") {
                        k = rep[i];
                        v = str(k, value);
                        if (v) {
                          partial.push(quote(k) + (gap ? ": " : ":") + v);
                        }
                      }
                    }
                  } else {
                    // Otherwise, iterate through all of the keys in the object.

                    for (k in value) {
                      if (Object.prototype.hasOwnProperty.call(value, k)) {
                        v = str(k, value);
                        if (v) {
                          partial.push(quote(k) + (gap ? ": " : ":") + v);
                        }
                      }
                    }
                  }

                  // Join all of the member texts together, separated with commas,
                  // and wrap them in braces.

                  v =
                    partial.length === 0
                      ? "{}"
                      : gap
                      ? "{\n" +
                        gap +
                        partial.join(",\n" + gap) +
                        "\n" +
                        mind +
                        "}"
                      : "{" + partial.join(",") + "}";
                  gap = mind;
                  return v;
              }
            }

            // If the JSON object does not yet have a stringify method, give it one.

            JSON.stringify = function(value, replacer, space) {
              // The stringify method takes a value and an optional replacer, and an optional
              // space parameter, and returns a JSON text. The replacer can be a function
              // that can replace values, or an array of strings that will select the keys.
              // A default replacer method can be provided. Use of the space parameter can
              // produce text that is more easily readable.

              var i;
              gap = "";
              indent = "";

              // If the space parameter is a number, make an indent string containing that
              // many spaces.

              if (typeof space === "number") {
                for (i = 0; i < space; i += 1) {
                  indent += " ";
                }

                // If the space parameter is a string, it will be used as the indent string.
              } else if (typeof space === "string") {
                indent = space;
              }

              // If there is a replacer, it must be a function or an array.
              // Otherwise, throw an error.

              rep = replacer;
              if (
                replacer &&
                typeof replacer !== "function" &&
                (typeof replacer !== "object" ||
                  typeof replacer.length !== "number")
              ) {
                throw new Error("JSON.stringify");
              }

              // Make a fake root object containing our value under the key of ''.
              // Return the result of stringifying the value.

              return str("", { "": value });
            };

            // If the JSON object does not yet have a parse method, give it one.

            JSON.parse = function(text, reviver) {
              // The parse method takes a text and an optional reviver function, and returns
              // a JavaScript value if the text is a valid JSON text.

              var j;

              function walk(holder, key) {
                // The walk method is used to recursively walk the resulting structure so
                // that modifications can be made.

                var k,
                  v,
                  value = holder[key];
                if (value && typeof value === "object") {
                  for (k in value) {
                    if (Object.prototype.hasOwnProperty.call(value, k)) {
                      v = walk(value, k);
                      if (v !== undefined) {
                        value[k] = v;
                      } else {
                        delete value[k];
                      }
                    }
                  }
                }
                return reviver.call(holder, key, value);
              }

              // Parsing happens in four stages. In the first stage, we replace certain
              // Unicode characters with escape sequences. JavaScript handles many characters
              // incorrectly, either silently deleting them, or treating them as line endings.

              text = String(text);
              cx.lastIndex = 0;
              if (cx.test(text)) {
                text = text.replace(cx, function(a) {
                  return (
                    "\\u" + ("0000" + a.charCodeAt(0).toString(16)).slice(-4)
                  );
                });
              }

              // In the second stage, we run the text against regular expressions that look
              // for non-JSON patterns. We are especially concerned with '()' and 'new'
              // because they can cause invocation, and '=' because it can cause mutation.
              // But just to be safe, we want to reject all unexpected forms.

              // We split the second stage into 4 regexp operations in order to work around
              // crippling inefficiencies in IE's and Safari's regexp engines. First we
              // replace the JSON backslash pairs with '@' (a non-JSON character). Second, we
              // replace all simple value tokens with ']' characters. Third, we delete all
              // open brackets that follow a colon or comma or that begin the text. Finally,
              // we look to see that the remaining characters are only whitespace or ']' or
              // ',' or ':' or '{' or '}'. If that is so, then the text is safe for eval.

              if (
                /^[\],:{}\s]*$/.test(
                  text
                    .replace(/\\(?:["\\\/bfnrt]|u[0-9a-fA-F]{4})/g, "@")
                    .replace(
                      /"[^"\\\n\r]*"|true|false|null|-?\d+(?:\.\d*)?(?:[eE][+\-]?\d+)?/g,
                      "]"
                    )
                    .replace(/(?:^|:|,)(?:\s*\[)+/g, "")
                )
              ) {
                // In the third stage we use the eval function to compile the text into a
                // JavaScript structure. The '{' operator is subject to a syntactic ambiguity
                // in JavaScript: it can begin a block or an object literal. We wrap the text
                // in parens to eliminate the ambiguity.

                j = eval("(" + text + ")");

                // In the optional fourth stage, we recursively walk the new structure, passing
                // each name/value pair to a reviver function for possible transformation.

                return typeof reviver === "function" ? walk({ "": j }, "") : j;
              }

              // If the text is not JSON parseable, then a SyntaxError is thrown.

              throw new SyntaxError("JSON.parse");
            };
          })(
            "undefined" != typeof io ? io : module.exports,
            typeof JSON !== "undefined" ? JSON : undefined
          );

          /**
           * socket.io
           * Copyright(c) 2011 LearnBoost <dev@learnboost.com>
           * MIT Licensed
           */

          (function(exports, io) {
            /**
             * Parser namespace.
             *
             * @namespace
             */

            var parser = (exports.parser = {});

            /**
             * Packet types.
             */

            var packets = (parser.packets = [
              "disconnect",
              "connect",
              "heartbeat",
              "message",
              "json",
              "event",
              "ack",
              "error",
              "noop"
            ]);

            /**
             * Errors reasons.
             */

            var reasons = (parser.reasons = [
              "transport not supported",
              "client not handshaken",
              "unauthorized"
            ]);

            /**
             * Errors advice.
             */

            var advice = (parser.advice = ["reconnect"]);

            /**
             * Shortcuts.
             */

            var JSON = io.JSON,
              indexOf = io.util.indexOf;

            /**
             * Encodes a packet.
             *
             * @api private
             */

            parser.encodePacket = function(packet) {
              var type = indexOf(packets, packet.type),
                id = packet.id || "",
                endpoint = packet.endpoint || "",
                ack = packet.ack,
                data = null;

              switch (packet.type) {
                case "error":
                  var reason = packet.reason
                      ? indexOf(reasons, packet.reason)
                      : "",
                    adv = packet.advice ? indexOf(advice, packet.advice) : "";

                  if (reason !== "" || adv !== "")
                    data = reason + (adv !== "" ? "+" + adv : "");

                  break;

                case "message":
                  if (packet.data !== "") data = packet.data;
                  break;

                case "event":
                  var ev = { name: packet.name };

                  if (packet.args && packet.args.length) {
                    ev.args = packet.args;
                  }

                  data = JSON.stringify(ev);
                  break;

                case "json":
                  data = JSON.stringify(packet.data);
                  break;

                case "connect":
                  if (packet.qs) data = packet.qs;
                  break;

                case "ack":
                  data =
                    packet.ackId +
                    (packet.args && packet.args.length
                      ? "+" + JSON.stringify(packet.args)
                      : "");
                  break;
              }

              // construct packet with required fragments
              var encoded = [type, id + (ack == "data" ? "+" : ""), endpoint];

              // data fragment is optional
              if (data !== null && data !== undefined) encoded.push(data);

              return encoded.join(":");
            };

            /**
             * Encodes multiple messages (payload).
             *
             * @param {Array} messages
             * @api private
             */

            parser.encodePayload = function(packets) {
              var decoded = "";

              if (packets.length == 1) return packets[0];

              for (var i = 0, l = packets.length; i < l; i++) {
                var packet = packets[i];
                decoded += "\ufffd" + packet.length + "\ufffd" + packets[i];
              }

              return decoded;
            };

            /**
             * Decodes a packet
             *
             * @api private
             */

            var regexp = /([^:]+):([0-9]+)?(\+)?:([^:]+)?:?([\s\S]*)?/;

            parser.decodePacket = function(data) {
              var pieces = data.match(regexp);

              if (!pieces) return {};

              var id = pieces[2] || "",
                data = pieces[5] || "",
                packet = {
                  type: packets[pieces[1]],
                  endpoint: pieces[4] || ""
                };

              // whether we need to acknowledge the packet
              if (id) {
                packet.id = id;
                if (pieces[3]) packet.ack = "data";
                else packet.ack = true;
              }

              // handle different packet types
              switch (packet.type) {
                case "error":
                  var pieces = data.split("+");
                  packet.reason = reasons[pieces[0]] || "";
                  packet.advice = advice[pieces[1]] || "";
                  break;

                case "message":
                  packet.data = data || "";
                  break;

                case "event":
                  try {
                    var opts = JSON.parse(data);
                    packet.name = opts.name;
                    packet.args = opts.args;
                  } catch (e) {}

                  packet.args = packet.args || [];
                  break;

                case "json":
                  try {
                    packet.data = JSON.parse(data);
                  } catch (e) {}
                  break;

                case "connect":
                  packet.qs = data || "";
                  break;

                case "ack":
                  var pieces = data.match(/^([0-9]+)(\+)?(.*)/);
                  if (pieces) {
                    packet.ackId = pieces[1];
                    packet.args = [];

                    if (pieces[3]) {
                      try {
                        packet.args = pieces[3] ? JSON.parse(pieces[3]) : [];
                      } catch (e) {}
                    }
                  }
                  break;

                case "disconnect":
                case "heartbeat":
                  break;
              }

              return packet;
            };

            /**
             * Decodes data payload. Detects multiple messages
             *
             * @return {Array} messages
             * @api public
             */

            parser.decodePayload = function(data) {
              // IE doesn't like data[i] for unicode chars, charAt works fine
              if (data.charAt(0) == "\ufffd") {
                var ret = [];

                for (var i = 1, length = ""; i < data.length; i++) {
                  if (data.charAt(i) == "\ufffd") {
                    ret.push(
                      parser.decodePacket(data.substr(i + 1).substr(0, length))
                    );
                    i += Number(length) + 1;
                    length = "";
                  } else {
                    length += data.charAt(i);
                  }
                }

                return ret;
              } else {
                return [parser.decodePacket(data)];
              }
            };
          })(
            "undefined" != typeof io ? io : module.exports,
            "undefined" != typeof io ? io : module.parent.exports
          );
          /**
           * socket.io
           * Copyright(c) 2011 LearnBoost <dev@learnboost.com>
           * MIT Licensed
           */

          (function(exports, io) {
            /**
             * Expose constructor.
             */

            exports.Transport = Transport;

            /**
             * This is the transport template for all supported transport methods.
             *
             * @constructor
             * @api public
             */

            function Transport(socket, sessid) {
              this.socket = socket;
              this.sessid = sessid;
            }

            /**
             * Apply EventEmitter mixin.
             */

            io.util.mixin(Transport, io.EventEmitter);

            /**
             * Indicates whether heartbeats is enabled for this transport
             *
             * @api private
             */

            Transport.prototype.heartbeats = function() {
              return true;
            };

            /**
             * Handles the response from the server. When a new response is received
             * it will automatically update the timeout, decode the message and
             * forwards the response to the onMessage function for further processing.
             *
             * @param {String} data Response from the server.
             * @api private
             */

            Transport.prototype.onData = function(data) {
              this.clearCloseTimeout();

              // If the connection in currently open (or in a reopening state) reset the close
              // timeout since we have just received data. This check is necessary so
              // that we don't reset the timeout on an explicitly disconnected connection.
              if (
                this.socket.connected ||
                this.socket.connecting ||
                this.socket.reconnecting
              ) {
                this.setCloseTimeout();
              }

              if (data !== "") {
                // todo: we should only do decodePayload for xhr transports
                var msgs = io.parser.decodePayload(data);

                if (msgs && msgs.length) {
                  for (var i = 0, l = msgs.length; i < l; i++) {
                    this.onPacket(msgs[i]);
                  }
                }
              }

              return this;
            };

            /**
             * Handles packets.
             *
             * @api private
             */

            Transport.prototype.onPacket = function(packet) {
              this.socket.setHeartbeatTimeout();

              if (packet.type == "heartbeat") {
                return this.onHeartbeat();
              }

              if (packet.type == "connect" && packet.endpoint == "") {
                this.onConnect();
              }

              if (packet.type == "error" && packet.advice == "reconnect") {
                this.isOpen = false;
              }

              this.socket.onPacket(packet);

              return this;
            };

            /**
             * Sets close timeout
             *
             * @api private
             */

            Transport.prototype.setCloseTimeout = function() {
              if (!this.closeTimeout) {
                var self = this;

                this.closeTimeout = setTimeout(function() {
                  self.onDisconnect();
                }, this.socket.closeTimeout);
              }
            };

            /**
             * Called when transport disconnects.
             *
             * @api private
             */

            Transport.prototype.onDisconnect = function() {
              if (this.isOpen) this.close();
              this.clearTimeouts();
              this.socket.onDisconnect();
              return this;
            };

            /**
             * Called when transport connects
             *
             * @api private
             */

            Transport.prototype.onConnect = function() {
              this.socket.onConnect();
              return this;
            };

            /**
             * Clears close timeout
             *
             * @api private
             */

            Transport.prototype.clearCloseTimeout = function() {
              if (this.closeTimeout) {
                clearTimeout(this.closeTimeout);
                this.closeTimeout = null;
              }
            };

            /**
             * Clear timeouts
             *
             * @api private
             */

            Transport.prototype.clearTimeouts = function() {
              this.clearCloseTimeout();

              if (this.reopenTimeout) {
                clearTimeout(this.reopenTimeout);
              }
            };

            /**
             * Sends a packet
             *
             * @param {Object} packet object.
             * @api private
             */

            Transport.prototype.packet = function(packet) {
              this.send(io.parser.encodePacket(packet));
            };

            /**
             * Send the received heartbeat message back to server. So the server
             * knows we are still connected.
             *
             * @param {String} heartbeat Heartbeat response from the server.
             * @api private
             */

            Transport.prototype.onHeartbeat = function(heartbeat) {
              this.packet({ type: "heartbeat" });
            };

            /**
             * Called when the transport opens.
             *
             * @api private
             */

            Transport.prototype.onOpen = function() {
              this.isOpen = true;
              this.clearCloseTimeout();
              this.socket.onOpen();
            };

            /**
             * Notifies the base when the connection with the Socket.IO server
             * has been disconnected.
             *
             * @api private
             */

            Transport.prototype.onClose = function() {
              var self = this;

              /* FIXME: reopen delay causing a infinit loop
    this.reopenTimeout = setTimeout(function () {
      self.open();
    }, this.socket.options['reopen delay']);*/

              this.isOpen = false;
              this.socket.onClose();
              this.onDisconnect();
            };

            /**
             * Generates a connection url based on the Socket.IO URL Protocol.
             * See <https://github.com/learnboost/socket.io-node/> for more details.
             *
             * @returns {String} Connection url
             * @api private
             */

            Transport.prototype.prepareUrl = function() {
              var options = this.socket.options;

              return (
                this.scheme() +
                "://" +
                options.host +
                ":" +
                options.port +
                "/" +
                options.resource +
                "/" +
                io.protocol +
                "/" +
                this.name +
                "/" +
                this.sessid
              );
            };

            /**
             * Checks if the transport is ready to start a connection.
             *
             * @param {Socket} socket The socket instance that needs a transport
             * @param {Function} fn The callback
             * @api private
             */

            Transport.prototype.ready = function(socket, fn) {
              fn.call(this);
            };
          })(
            "undefined" != typeof io ? io : module.exports,
            "undefined" != typeof io ? io : module.parent.exports
          );
          /**
           * socket.io
           * Copyright(c) 2011 LearnBoost <dev@learnboost.com>
           * MIT Licensed
           */

          (function(exports, io, global) {
            /**
             * Expose constructor.
             */

            exports.Socket = Socket;

            /**
             * Create a new `Socket.IO client` which can establish a persistent
             * connection with a Socket.IO enabled server.
             *
             * @api public
             */

            function Socket(options) {
              this.options = {
                port: 80,
                secure: false,
                document: "document" in global ? document : false,
                resource: "socket.io",
                transports: io.transports,
                "connect timeout": 10000,
                "try multiple transports": true,
                reconnect: true,
                "reconnection delay": 500,
                "reconnection limit": Infinity,
                "reopen delay": 3000,
                "max reconnection attempts": 10,
                "sync disconnect on unload": false,
                "auto connect": true,
                "flash policy port": 10843,
                manualFlush: false
              };

              io.util.merge(this.options, options);

              this.connected = false;
              this.open = false;
              this.connecting = false;
              this.reconnecting = false;
              this.namespaces = {};
              this.buffer = [];
              this.doBuffer = false;

              if (
                this.options["sync disconnect on unload"] &&
                (!this.isXDomain() || io.util.ua.hasCORS)
              ) {
                var self = this;
                io.util.on(
                  global,
                  "beforeunload",
                  function() {
                    self.disconnectSync();
                  },
                  false
                );
              }

              if (this.options["auto connect"]) {
                this.connect();
              }
            }

            /**
             * Apply EventEmitter mixin.
             */

            io.util.mixin(Socket, io.EventEmitter);

            /**
             * Returns a namespace listener/emitter for this socket
             *
             * @api public
             */

            Socket.prototype.of = function(name) {
              if (!this.namespaces[name]) {
                this.namespaces[name] = new io.SocketNamespace(this, name);

                if (name !== "") {
                  this.namespaces[name].packet({ type: "connect" });
                }
              }

              return this.namespaces[name];
            };

            /**
             * Emits the given event to the Socket and all namespaces
             *
             * @api private
             */

            Socket.prototype.publish = function() {
              this.emit.apply(this, arguments);

              var nsp;

              for (var i in this.namespaces) {
                if (this.namespaces.hasOwnProperty(i)) {
                  nsp = this.of(i);
                  nsp.$emit.apply(nsp, arguments);
                }
              }
            };

            /**
             * Performs the handshake
             *
             * @api private
             */

            function empty() {}

            Socket.prototype.handshake = function(fn) {
              var self = this,
                options = this.options;

              function complete(data) {
                if (data instanceof Error) {
                  self.connecting = false;
                  self.onError(data.message);
                } else {
                  fn.apply(null, data.split(":"));
                }
              }

              var url = [
                "http" + (options.secure ? "s" : "") + ":/",
                options.host + ":" + options.port,
                options.resource,
                io.protocol,
                io.util.query(this.options.query, "t=" + +new Date())
              ].join("/");

              if (this.isXDomain() && !io.util.ua.hasCORS) {
                var insertAt = document.getElementsByTagName("script")[0],
                  script = document.createElement("script");

                script.src = url + "&jsonp=" + io.j.length;
                insertAt.parentNode.insertBefore(script, insertAt);

                io.j.push(function(data) {
                  complete(data);
                  script.parentNode.removeChild(script);
                });
              } else {
                var xhr = io.util.request();

                xhr.open("GET", url, true);
                if (this.isXDomain()) {
                  xhr.withCredentials = true;
                }
                xhr.onreadystatechange = function() {
                  if (xhr.readyState == 4) {
                    xhr.onreadystatechange = empty;

                    if (xhr.status == 200) {
                      complete(xhr.responseText);
                    } else if (xhr.status == 403) {
                      self.onError(xhr.responseText);
                    } else {
                      self.connecting = false;
                      !self.reconnecting && self.onError(xhr.responseText);
                    }
                  }
                };
                xhr.send(null);
              }
            };

            /**
             * Find an available transport based on the options supplied in the constructor.
             *
             * @api private
             */

            Socket.prototype.getTransport = function(override) {
              var transports = override || this.transports,
                match;

              for (var i = 0, transport; (transport = transports[i]); i++) {
                if (
                  io.Transport[transport] &&
                  io.Transport[transport].check(this) &&
                  (!this.isXDomain() ||
                    io.Transport[transport].xdomainCheck(this))
                ) {
                  return new io.Transport[transport](this, this.sessionid);
                }
              }

              return null;
            };

            /**
             * Connects to the server.
             *
             * @param {Function} [fn] Callback.
             * @returns {io.Socket}
             * @api public
             */

            Socket.prototype.connect = function(fn) {
              if (this.connecting) {
                return this;
              }

              var self = this;
              self.connecting = true;

              this.handshake(function(sid, heartbeat, close, transports) {
                self.sessionid = sid;
                self.closeTimeout = close * 1000;
                self.heartbeatTimeout = heartbeat * 1000;
                if (!self.transports)
                  self.transports = self.origTransports = transports
                    ? io.util.intersect(
                        transports.split(","),
                        self.options.transports
                      )
                    : self.options.transports;

                self.setHeartbeatTimeout();

                function connect(transports) {
                  if (self.transport) self.transport.clearTimeouts();

                  self.transport = self.getTransport(transports);
                  if (!self.transport) return self.publish("connect_failed");

                  // once the transport is ready
                  self.transport.ready(self, function() {
                    self.connecting = true;
                    self.publish("connecting", self.transport.name);
                    self.transport.open();

                    if (self.options["connect timeout"]) {
                      self.connectTimeoutTimer = setTimeout(function() {
                        if (!self.connected) {
                          self.connecting = false;

                          if (self.options["try multiple transports"]) {
                            var remaining = self.transports;

                            while (
                              remaining.length > 0 &&
                              remaining.splice(0, 1)[0] != self.transport.name
                            ) {}

                            if (remaining.length) {
                              connect(remaining);
                            } else {
                              self.publish("connect_failed");
                            }
                          }
                        }
                      }, self.options["connect timeout"]);
                    }
                  });
                }

                connect(self.transports);

                self.once("connect", function() {
                  clearTimeout(self.connectTimeoutTimer);

                  fn && typeof fn == "function" && fn();
                });
              });

              return this;
            };

            /**
             * Clears and sets a new heartbeat timeout using the value given by the
             * server during the handshake.
             *
             * @api private
             */

            Socket.prototype.setHeartbeatTimeout = function() {
              clearTimeout(this.heartbeatTimeoutTimer);
              if (this.transport && !this.transport.heartbeats()) return;

              var self = this;
              this.heartbeatTimeoutTimer = setTimeout(function() {
                self.transport.onClose();
              }, this.heartbeatTimeout);
            };

            /**
             * Sends a message.
             *
             * @param {Object} data packet.
             * @returns {io.Socket}
             * @api public
             */

            Socket.prototype.packet = function(data) {
              if (this.connected && !this.doBuffer) {
                this.transport.packet(data);
              } else {
                this.buffer.push(data);
              }

              return this;
            };

            /**
             * Sets buffer state
             *
             * @api private
             */

            Socket.prototype.setBuffer = function(v) {
              this.doBuffer = v;

              if (!v && this.connected && this.buffer.length) {
                if (!this.options["manualFlush"]) {
                  this.flushBuffer();
                }
              }
            };

            /**
             * Flushes the buffer data over the wire.
             * To be invoked manually when 'manualFlush' is set to true.
             *
             * @api public
             */

            Socket.prototype.flushBuffer = function() {
              this.transport.payload(this.buffer);
              this.buffer = [];
            };

            /**
             * Disconnect the established connect.
             *
             * @returns {io.Socket}
             * @api public
             */

            Socket.prototype.disconnect = function() {
              if (this.connected || this.connecting) {
                if (this.open) {
                  this.of("").packet({ type: "disconnect" });
                }

                // handle disconnection immediately
                this.onDisconnect("booted");
              }

              return this;
            };

            /**
             * Disconnects the socket with a sync XHR.
             *
             * @api private
             */

            Socket.prototype.disconnectSync = function() {
              // ensure disconnection
              var xhr = io.util.request();
              var uri =
                [
                  "http" + (this.options.secure ? "s" : "") + ":/",
                  this.options.host + ":" + this.options.port,
                  this.options.resource,
                  io.protocol,
                  "",
                  this.sessionid
                ].join("/") + "/?disconnect=1";

              xhr.open("GET", uri, false);
              xhr.send(null);

              // handle disconnection immediately
              this.onDisconnect("booted");
            };

            /**
             * Check if we need to use cross domain enabled transports. Cross domain would
             * be a different port or different domain name.
             *
             * @returns {Boolean}
             * @api private
             */

            Socket.prototype.isXDomain = function() {
              var port =
                global.location.port ||
                ("https:" == global.location.protocol ? 443 : 80);

              return (
                this.options.host !== global.location.hostname ||
                this.options.port != port
              );
            };

            /**
             * Called upon handshake.
             *
             * @api private
             */

            Socket.prototype.onConnect = function() {
              if (!this.connected) {
                this.connected = true;
                this.connecting = false;
                if (!this.doBuffer) {
                  // make sure to flush the buffer
                  this.setBuffer(false);
                }
                this.emit("connect");
              }
            };

            /**
             * Called when the transport opens
             *
             * @api private
             */

            Socket.prototype.onOpen = function() {
              this.open = true;
            };

            /**
             * Called when the transport closes.
             *
             * @api private
             */

            Socket.prototype.onClose = function() {
              this.open = false;
              clearTimeout(this.heartbeatTimeoutTimer);
            };

            /**
             * Called when the transport first opens a connection
             *
             * @param text
             */

            Socket.prototype.onPacket = function(packet) {
              this.of(packet.endpoint).onPacket(packet);
            };

            /**
             * Handles an error.
             *
             * @api private
             */

            Socket.prototype.onError = function(err) {
              if (err && err.advice) {
                if (
                  err.advice === "reconnect" &&
                  (this.connected || this.connecting)
                ) {
                  this.disconnect();
                  if (this.options.reconnect) {
                    this.reconnect();
                  }
                }
              }

              this.publish("error", err && err.reason ? err.reason : err);
            };

            /**
             * Called when the transport disconnects.
             *
             * @api private
             */

            Socket.prototype.onDisconnect = function(reason) {
              var wasConnected = this.connected,
                wasConnecting = this.connecting;

              this.connected = false;
              this.connecting = false;
              this.open = false;

              if (wasConnected || wasConnecting) {
                this.transport.close();
                this.transport.clearTimeouts();
                if (wasConnected) {
                  this.publish("disconnect", reason);

                  if (
                    "booted" != reason &&
                    this.options.reconnect &&
                    !this.reconnecting
                  ) {
                    this.reconnect();
                  }
                }
              }
            };

            /**
             * Called upon reconnection.
             *
             * @api private
             */

            Socket.prototype.reconnect = function() {
              this.reconnecting = true;
              this.reconnectionAttempts = 0;
              this.reconnectionDelay = this.options["reconnection delay"];

              var self = this,
                maxAttempts = this.options["max reconnection attempts"],
                tryMultiple = this.options["try multiple transports"],
                limit = this.options["reconnection limit"];

              function reset() {
                if (self.connected) {
                  for (var i in self.namespaces) {
                    if (self.namespaces.hasOwnProperty(i) && "" !== i) {
                      self.namespaces[i].packet({ type: "connect" });
                    }
                  }
                  self.publish(
                    "reconnect",
                    self.transport.name,
                    self.reconnectionAttempts
                  );
                }

                clearTimeout(self.reconnectionTimer);

                self.removeListener("connect_failed", maybeReconnect);
                self.removeListener("connect", maybeReconnect);

                self.reconnecting = false;

                delete self.reconnectionAttempts;
                delete self.reconnectionDelay;
                delete self.reconnectionTimer;
                delete self.redoTransports;

                self.options["try multiple transports"] = tryMultiple;
              }

              function maybeReconnect() {
                if (!self.reconnecting) {
                  return;
                }

                if (self.connected) {
                  return reset();
                }

                if (self.connecting && self.reconnecting) {
                  return (self.reconnectionTimer = setTimeout(
                    maybeReconnect,
                    1000
                  ));
                }

                if (self.reconnectionAttempts++ >= maxAttempts) {
                  if (!self.redoTransports) {
                    self.on("connect_failed", maybeReconnect);
                    self.options["try multiple transports"] = true;
                    self.transports = self.origTransports;
                    self.transport = self.getTransport();
                    self.redoTransports = true;
                    self.connect();
                  } else {
                    self.publish("reconnect_failed");
                    reset();
                  }
                } else {
                  if (self.reconnectionDelay < limit) {
                    self.reconnectionDelay *= 2; // exponential back off
                  }

                  self.connect();
                  self.publish(
                    "reconnecting",
                    self.reconnectionDelay,
                    self.reconnectionAttempts
                  );
                  self.reconnectionTimer = setTimeout(
                    maybeReconnect,
                    self.reconnectionDelay
                  );
                }
              }

              this.options["try multiple transports"] = false;
              this.reconnectionTimer = setTimeout(
                maybeReconnect,
                this.reconnectionDelay
              );

              this.on("connect", maybeReconnect);
            };
          })(
            "undefined" != typeof io ? io : module.exports,
            "undefined" != typeof io ? io : module.parent.exports,
            this
          );
          /**
           * socket.io
           * Copyright(c) 2011 LearnBoost <dev@learnboost.com>
           * MIT Licensed
           */

          (function(exports, io) {
            /**
             * Expose constructor.
             */

            exports.SocketNamespace = SocketNamespace;

            /**
             * Socket namespace constructor.
             *
             * @constructor
             * @api public
             */

            function SocketNamespace(socket, name) {
              this.socket = socket;
              this.name = name || "";
              this.flags = {};
              this.json = new Flag(this, "json");
              this.ackPackets = 0;
              this.acks = {};
            }

            /**
             * Apply EventEmitter mixin.
             */

            io.util.mixin(SocketNamespace, io.EventEmitter);

            /**
             * Copies emit since we override it
             *
             * @api private
             */

            SocketNamespace.prototype.$emit = io.EventEmitter.prototype.emit;

            /**
             * Creates a new namespace, by proxying the request to the socket. This
             * allows us to use the synax as we do on the server.
             *
             * @api public
             */

            SocketNamespace.prototype.of = function() {
              return this.socket.of.apply(this.socket, arguments);
            };

            /**
             * Sends a packet.
             *
             * @api private
             */

            SocketNamespace.prototype.packet = function(packet) {
              packet.endpoint = this.name;
              this.socket.packet(packet);
              this.flags = {};
              return this;
            };

            /**
             * Sends a message
             *
             * @api public
             */

            SocketNamespace.prototype.send = function(data, fn) {
              var packet = {
                type: this.flags.json ? "json" : "message",
                data: data
              };

              if ("function" == typeof fn) {
                packet.id = ++this.ackPackets;
                packet.ack = true;
                this.acks[packet.id] = fn;
              }

              return this.packet(packet);
            };

            /**
             * Emits an event
             *
             * @api public
             */

            SocketNamespace.prototype.emit = function(name) {
              var args = Array.prototype.slice.call(arguments, 1),
                lastArg = args[args.length - 1],
                packet = {
                  type: "event",
                  name: name
                };

              if ("function" == typeof lastArg) {
                packet.id = ++this.ackPackets;
                packet.ack = "data";
                this.acks[packet.id] = lastArg;
                args = args.slice(0, args.length - 1);
              }

              packet.args = args;

              return this.packet(packet);
            };

            /**
             * Disconnects the namespace
             *
             * @api private
             */

            SocketNamespace.prototype.disconnect = function() {
              if (this.name === "") {
                this.socket.disconnect();
              } else {
                this.packet({ type: "disconnect" });
                this.$emit("disconnect");
              }

              return this;
            };

            /**
             * Handles a packet
             *
             * @api private
             */

            SocketNamespace.prototype.onPacket = function(packet) {
              var self = this;

              function ack() {
                self.packet({
                  type: "ack",
                  args: io.util.toArray(arguments),
                  ackId: packet.id
                });
              }

              switch (packet.type) {
                case "connect":
                  this.$emit("connect");
                  break;

                case "disconnect":
                  if (this.name === "") {
                    this.socket.onDisconnect(packet.reason || "booted");
                  } else {
                    this.$emit("disconnect", packet.reason);
                  }
                  break;

                case "message":
                case "json":
                  var params = ["message", packet.data];

                  if (packet.ack == "data") {
                    params.push(ack);
                  } else if (packet.ack) {
                    this.packet({ type: "ack", ackId: packet.id });
                  }

                  this.$emit.apply(this, params);
                  break;

                case "event":
                  var params = [packet.name].concat(packet.args);

                  if (packet.ack == "data") params.push(ack);

                  this.$emit.apply(this, params);
                  break;

                case "ack":
                  if (this.acks[packet.ackId]) {
                    this.acks[packet.ackId].apply(this, packet.args);
                    delete this.acks[packet.ackId];
                  }
                  break;

                case "error":
                  if (packet.advice) {
                    this.socket.onError(packet);
                  } else {
                    if (packet.reason == "unauthorized") {
                      this.$emit("connect_failed", packet.reason);
                    } else {
                      this.$emit("error", packet.reason);
                    }
                  }
                  break;
              }
            };

            /**
             * Flag interface.
             *
             * @api private
             */

            function Flag(nsp, name) {
              this.namespace = nsp;
              this.name = name;
            }

            /**
             * Send a message
             *
             * @api public
             */

            Flag.prototype.send = function() {
              this.namespace.flags[this.name] = true;
              this.namespace.send.apply(this.namespace, arguments);
            };

            /**
             * Emit an event
             *
             * @api public
             */

            Flag.prototype.emit = function() {
              this.namespace.flags[this.name] = true;
              this.namespace.emit.apply(this.namespace, arguments);
            };
          })(
            "undefined" != typeof io ? io : module.exports,
            "undefined" != typeof io ? io : module.parent.exports
          );

          /**
           * socket.io
           * Copyright(c) 2011 LearnBoost <dev@learnboost.com>
           * MIT Licensed
           */

          (function(exports, io, global) {
            /**
             * Expose constructor.
             */

            exports.websocket = WS;

            /**
             * The WebSocket transport uses the HTML5 WebSocket API to establish an
             * persistent connection with the Socket.IO server. This transport will also
             * be inherited by the FlashSocket fallback as it provides a API compatible
             * polyfill for the WebSockets.
             *
             * @constructor
             * @extends {io.Transport}
             * @api public
             */

            function WS(socket) {
              io.Transport.apply(this, arguments);
            }

            /**
             * Inherits from Transport.
             */

            io.util.inherit(WS, io.Transport);

            /**
             * Transport name
             *
             * @api public
             */

            WS.prototype.name = "websocket";

            /**
             * Initializes a new `WebSocket` connection with the Socket.IO server. We attach
             * all the appropriate listeners to handle the responses from the server.
             *
             * @returns {Transport}
             * @api public
             */

            WS.prototype.open = function() {
              var query = io.util.query(this.socket.options.query),
                self = this,
                Socket;

              if (!Socket) {
                Socket = global.MozWebSocket || global.WebSocket;
              }

              this.websocket = new Socket(this.prepareUrl() + query);

              this.websocket.onopen = function() {
                self.onOpen();
                self.socket.setBuffer(false);
              };
              this.websocket.onmessage = function(ev) {
                self.onData(ev.data);
              };
              this.websocket.onclose = function() {
                self.onClose();
                self.socket.setBuffer(true);
              };
              this.websocket.onerror = function(e) {
                self.onError(e);
              };

              return this;
            };

            /**
             * Send a message to the Socket.IO server. The message will automatically be
             * encoded in the correct message format.
             *
             * @returns {Transport}
             * @api public
             */

            // Do to a bug in the current IDevices browser, we need to wrap the send in a
            // setTimeout, when they resume from sleeping the browser will crash if
            // we don't allow the browser time to detect the socket has been closed
            if (io.util.ua.iDevice) {
              WS.prototype.send = function(data) {
                var self = this;
                setTimeout(function() {
                  self.websocket.send(data);
                }, 0);
                return this;
              };
            } else {
              WS.prototype.send = function(data) {
                this.websocket.send(data);
                return this;
              };
            }

            /**
             * Payload
             *
             * @api private
             */

            WS.prototype.payload = function(arr) {
              for (var i = 0, l = arr.length; i < l; i++) {
                this.packet(arr[i]);
              }
              return this;
            };

            /**
             * Disconnect the established `WebSocket` connection.
             *
             * @returns {Transport}
             * @api public
             */

            WS.prototype.close = function() {
              this.websocket.close();
              return this;
            };

            /**
             * Handle the errors that `WebSocket` might be giving when we
             * are attempting to connect or send messages.
             *
             * @param {Error} e The error.
             * @api private
             */

            WS.prototype.onError = function(e) {
              this.socket.onError(e);
            };

            /**
             * Returns the appropriate scheme for the URI generation.
             *
             * @api private
             */
            WS.prototype.scheme = function() {
              return this.socket.options.secure ? "wss" : "ws";
            };

            /**
             * Checks if the browser has support for native `WebSockets` and that
             * it's not the polyfill created for the FlashSocket transport.
             *
             * @return {Boolean}
             * @api public
             */

            WS.check = function() {
              return (
                ("WebSocket" in global && !("__addTask" in WebSocket)) ||
                "MozWebSocket" in global
              );
            };

            /**
             * Check if the `WebSocket` transport support cross domain communications.
             *
             * @returns {Boolean}
             * @api public
             */

            WS.xdomainCheck = function() {
              return true;
            };

            /**
             * Add the transport to your public io.transports array.
             *
             * @api private
             */

            io.transports.push("websocket");
          })(
            "undefined" != typeof io ? io.Transport : module.exports,
            "undefined" != typeof io ? io : module.parent.exports,
            this
          );

          /**
           * socket.io
           * Copyright(c) 2011 LearnBoost <dev@learnboost.com>
           * MIT Licensed
           */

          (function(exports, io) {
            /**
             * Expose constructor.
             */

            exports.flashsocket = Flashsocket;

            /**
             * The FlashSocket transport. This is a API wrapper for the HTML5 WebSocket
             * specification. It uses a .swf file to communicate with the server. If you want
             * to serve the .swf file from a other server than where the Socket.IO script is
             * coming from you need to use the insecure version of the .swf. More information
             * about this can be found on the github page.
             *
             * @constructor
             * @extends {io.Transport.websocket}
             * @api public
             */

            function Flashsocket() {
              io.Transport.websocket.apply(this, arguments);
            }

            /**
             * Inherits from Transport.
             */

            io.util.inherit(Flashsocket, io.Transport.websocket);

            /**
             * Transport name
             *
             * @api public
             */

            Flashsocket.prototype.name = "flashsocket";

            /**
             * Disconnect the established `FlashSocket` connection. This is done by adding a
             * new task to the FlashSocket. The rest will be handled off by the `WebSocket`
             * transport.
             *
             * @returns {Transport}
             * @api public
             */

            Flashsocket.prototype.open = function() {
              var self = this,
                args = arguments;

              WebSocket.__addTask(function() {
                io.Transport.websocket.prototype.open.apply(self, args);
              });
              return this;
            };

            /**
             * Sends a message to the Socket.IO server. This is done by adding a new
             * task to the FlashSocket. The rest will be handled off by the `WebSocket`
             * transport.
             *
             * @returns {Transport}
             * @api public
             */

            Flashsocket.prototype.send = function() {
              var self = this,
                args = arguments;
              WebSocket.__addTask(function() {
                io.Transport.websocket.prototype.send.apply(self, args);
              });
              return this;
            };

            /**
             * Disconnects the established `FlashSocket` connection.
             *
             * @returns {Transport}
             * @api public
             */

            Flashsocket.prototype.close = function() {
              WebSocket.__tasks.length = 0;
              io.Transport.websocket.prototype.close.call(this);
              return this;
            };

            /**
             * The WebSocket fall back needs to append the flash container to the body
             * element, so we need to make sure we have access to it. Or defer the call
             * until we are sure there is a body element.
             *
             * @param {Socket} socket The socket instance that needs a transport
             * @param {Function} fn The callback
             * @api private
             */

            Flashsocket.prototype.ready = function(socket, fn) {
              function init() {
                var options = socket.options,
                  port = options["flash policy port"],
                  path = [
                    "http" + (options.secure ? "s" : "") + ":/",
                    options.host + ":" + options.port,
                    options.resource,
                    "static/flashsocket",
                    "WebSocketMain" +
                      (socket.isXDomain() ? "Insecure" : "") +
                      ".swf"
                  ];

                // Only start downloading the swf file when the checked that this browser
                // actually supports it
                if (!Flashsocket.loaded) {
                  if (typeof WEB_SOCKET_SWF_LOCATION === "undefined") {
                    // Set the correct file based on the XDomain settings
                    WEB_SOCKET_SWF_LOCATION = path.join("/");
                  }

                  if (port !== 843) {
                    WebSocket.loadFlashPolicyFile(
                      "xmlsocket://" + options.host + ":" + port
                    );
                  }

                  WebSocket.__initialize();
                  Flashsocket.loaded = true;
                }

                fn.call(self);
              }

              var self = this;
              if (document.body) return init();

              io.util.load(init);
            };

            /**
             * Check if the FlashSocket transport is supported as it requires that the Adobe
             * Flash Player plug-in version `10.0.0` or greater is installed. And also check if
             * the polyfill is correctly loaded.
             *
             * @returns {Boolean}
             * @api public
             */

            Flashsocket.check = function() {
              if (
                typeof WebSocket == "undefined" ||
                !("__initialize" in WebSocket) ||
                !swfobject
              )
                return false;

              return swfobject.getFlashPlayerVersion().major >= 10;
            };

            /**
             * Check if the FlashSocket transport can be used as cross domain / cross origin
             * transport. Because we can't see which type (secure or insecure) of .swf is used
             * we will just return true.
             *
             * @returns {Boolean}
             * @api public
             */

            Flashsocket.xdomainCheck = function() {
              return true;
            };

            /**
             * Disable AUTO_INITIALIZATION
             */

            if (typeof window != "undefined") {
              WEB_SOCKET_DISABLE_AUTO_INITIALIZATION = true;
            }

            /**
             * Add the transport to your public io.transports array.
             *
             * @api private
             */

            io.transports.push("flashsocket");
          })(
            "undefined" != typeof io ? io.Transport : module.exports,
            "undefined" != typeof io ? io : module.parent.exports
          );
          /*	SWFObject v2.2 <http://code.google.com/p/swfobject/> 
	is released under the MIT License <http://www.opensource.org/licenses/mit-license.php> 
*/
          if ("undefined" != typeof window) {
            var swfobject = (function() {
              var D = "undefined",
                r = "object",
                S = "Shockwave Flash",
                W = "ShockwaveFlash.ShockwaveFlash",
                q = "application/x-shockwave-flash",
                R = "SWFObjectExprInst",
                x = "onreadystatechange",
                O = window,
                j = document,
                t = navigator,
                T = false,
                U = [h],
                o = [],
                N = [],
                I = [],
                l,
                Q,
                E,
                B,
                J = false,
                a = false,
                n,
                G,
                m = true,
                M = (function() {
                  var aa =
                      typeof j.getElementById != D &&
                      typeof j.getElementsByTagName != D &&
                      typeof j.createElement != D,
                    ah = t.userAgent.toLowerCase(),
                    Y = t.platform.toLowerCase(),
                    ae = Y ? /win/.test(Y) : /win/.test(ah),
                    ac = Y ? /mac/.test(Y) : /mac/.test(ah),
                    af = /webkit/.test(ah)
                      ? parseFloat(
                          ah.replace(/^.*webkit\/(\d+(\.\d+)?).*$/, "$1")
                        )
                      : false,
                    X = !+"\v1",
                    ag = [0, 0, 0],
                    ab = null;
                  if (typeof t.plugins != D && typeof t.plugins[S] == r) {
                    ab = t.plugins[S].description;
                    if (
                      ab &&
                      !(
                        typeof t.mimeTypes != D &&
                        t.mimeTypes[q] &&
                        !t.mimeTypes[q].enabledPlugin
                      )
                    ) {
                      T = true;
                      X = false;
                      ab = ab.replace(/^.*\s+(\S+\s+\S+$)/, "$1");
                      ag[0] = parseInt(ab.replace(/^(.*)\..*$/, "$1"), 10);
                      ag[1] = parseInt(ab.replace(/^.*\.(.*)\s.*$/, "$1"), 10);
                      ag[2] = /[a-zA-Z]/.test(ab)
                        ? parseInt(ab.replace(/^.*[a-zA-Z]+(.*)$/, "$1"), 10)
                        : 0;
                    }
                  } else {
                    if (typeof O[["Active"].concat("Object").join("X")] != D) {
                      try {
                        var ad = new window[
                          ["Active"].concat("Object").join("X")
                        ](W);
                        if (ad) {
                          ab = ad.GetVariable("$version");
                          if (ab) {
                            X = true;
                            ab = ab.split(" ")[1].split(",");
                            ag = [
                              parseInt(ab[0], 10),
                              parseInt(ab[1], 10),
                              parseInt(ab[2], 10)
                            ];
                          }
                        }
                      } catch (Z) {}
                    }
                  }
                  return { w3: aa, pv: ag, wk: af, ie: X, win: ae, mac: ac };
                })(),
                k = (function() {
                  if (!M.w3) {
                    return;
                  }
                  if (
                    (typeof j.readyState != D && j.readyState == "complete") ||
                    (typeof j.readyState == D &&
                      (j.getElementsByTagName("body")[0] || j.body))
                  ) {
                    f();
                  }
                  if (!J) {
                    if (typeof j.addEventListener != D) {
                      j.addEventListener("DOMContentLoaded", f, false);
                    }
                    if (M.ie && M.win) {
                      j.attachEvent(x, function() {
                        if (j.readyState == "complete") {
                          j.detachEvent(x, arguments.callee);
                          f();
                        }
                      });
                      if (O == top) {
                        (function() {
                          if (J) {
                            return;
                          }
                          try {
                            j.documentElement.doScroll("left");
                          } catch (X) {
                            setTimeout(arguments.callee, 0);
                            return;
                          }
                          f();
                        })();
                      }
                    }
                    if (M.wk) {
                      (function() {
                        if (J) {
                          return;
                        }
                        if (!/loaded|complete/.test(j.readyState)) {
                          setTimeout(arguments.callee, 0);
                          return;
                        }
                        f();
                      })();
                    }
                    s(f);
                  }
                })();
              function f() {
                if (J) {
                  return;
                }
                try {
                  var Z = j
                    .getElementsByTagName("body")[0]
                    .appendChild(C("span"));
                  Z.parentNode.removeChild(Z);
                } catch (aa) {
                  return;
                }
                J = true;
                var X = U.length;
                for (var Y = 0; Y < X; Y++) {
                  U[Y]();
                }
              }
              function K(X) {
                if (J) {
                  X();
                } else {
                  U[U.length] = X;
                }
              }
              function s(Y) {
                if (typeof O.addEventListener != D) {
                  O.addEventListener("load", Y, false);
                } else {
                  if (typeof j.addEventListener != D) {
                    j.addEventListener("load", Y, false);
                  } else {
                    if (typeof O.attachEvent != D) {
                      i(O, "onload", Y);
                    } else {
                      if (typeof O.onload == "function") {
                        var X = O.onload;
                        O.onload = function() {
                          X();
                          Y();
                        };
                      } else {
                        O.onload = Y;
                      }
                    }
                  }
                }
              }
              function h() {
                if (T) {
                  V();
                } else {
                  H();
                }
              }
              function V() {
                var X = j.getElementsByTagName("body")[0];
                var aa = C(r);
                aa.setAttribute("type", q);
                var Z = X.appendChild(aa);
                if (Z) {
                  var Y = 0;
                  (function() {
                    if (typeof Z.GetVariable != D) {
                      var ab = Z.GetVariable("$version");
                      if (ab) {
                        ab = ab.split(" ")[1].split(",");
                        M.pv = [
                          parseInt(ab[0], 10),
                          parseInt(ab[1], 10),
                          parseInt(ab[2], 10)
                        ];
                      }
                    } else {
                      if (Y < 10) {
                        Y++;
                        setTimeout(arguments.callee, 10);
                        return;
                      }
                    }
                    X.removeChild(aa);
                    Z = null;
                    H();
                  })();
                } else {
                  H();
                }
              }
              function H() {
                var ag = o.length;
                if (ag > 0) {
                  for (var af = 0; af < ag; af++) {
                    var Y = o[af].id;
                    var ab = o[af].callbackFn;
                    var aa = { success: false, id: Y };
                    if (M.pv[0] > 0) {
                      var ae = c(Y);
                      if (ae) {
                        if (F(o[af].swfVersion) && !(M.wk && M.wk < 312)) {
                          w(Y, true);
                          if (ab) {
                            aa.success = true;
                            aa.ref = z(Y);
                            ab(aa);
                          }
                        } else {
                          if (o[af].expressInstall && A()) {
                            var ai = {};
                            ai.data = o[af].expressInstall;
                            ai.width = ae.getAttribute("width") || "0";
                            ai.height = ae.getAttribute("height") || "0";
                            if (ae.getAttribute("class")) {
                              ai.styleclass = ae.getAttribute("class");
                            }
                            if (ae.getAttribute("align")) {
                              ai.align = ae.getAttribute("align");
                            }
                            var ah = {};
                            var X = ae.getElementsByTagName("param");
                            var ac = X.length;
                            for (var ad = 0; ad < ac; ad++) {
                              if (
                                X[ad].getAttribute("name").toLowerCase() !=
                                "movie"
                              ) {
                                ah[X[ad].getAttribute("name")] = X[
                                  ad
                                ].getAttribute("value");
                              }
                            }
                            P(ai, ah, Y, ab);
                          } else {
                            p(ae);
                            if (ab) {
                              ab(aa);
                            }
                          }
                        }
                      }
                    } else {
                      w(Y, true);
                      if (ab) {
                        var Z = z(Y);
                        if (Z && typeof Z.SetVariable != D) {
                          aa.success = true;
                          aa.ref = Z;
                        }
                        ab(aa);
                      }
                    }
                  }
                }
              }
              function z(aa) {
                var X = null;
                var Y = c(aa);
                if (Y && Y.nodeName == "OBJECT") {
                  if (typeof Y.SetVariable != D) {
                    X = Y;
                  } else {
                    var Z = Y.getElementsByTagName(r)[0];
                    if (Z) {
                      X = Z;
                    }
                  }
                }
                return X;
              }
              function A() {
                return (
                  !a && F("6.0.65") && (M.win || M.mac) && !(M.wk && M.wk < 312)
                );
              }
              function P(aa, ab, X, Z) {
                a = true;
                E = Z || null;
                B = { success: false, id: X };
                var ae = c(X);
                if (ae) {
                  if (ae.nodeName == "OBJECT") {
                    l = g(ae);
                    Q = null;
                  } else {
                    l = ae;
                    Q = X;
                  }
                  aa.id = R;
                  if (
                    typeof aa.width == D ||
                    (!/%$/.test(aa.width) && parseInt(aa.width, 10) < 310)
                  ) {
                    aa.width = "310";
                  }
                  if (
                    typeof aa.height == D ||
                    (!/%$/.test(aa.height) && parseInt(aa.height, 10) < 137)
                  ) {
                    aa.height = "137";
                  }
                  j.title =
                    j.title.slice(0, 47) + " - Flash Player Installation";
                  var ad =
                      M.ie && M.win
                        ? ["Active"].concat("").join("X")
                        : "PlugIn",
                    ac =
                      "MMredirectURL=" +
                      O.location.toString().replace(/&/g, "%26") +
                      "&MMplayerType=" +
                      ad +
                      "&MMdoctitle=" +
                      j.title;
                  if (typeof ab.flashvars != D) {
                    ab.flashvars += "&" + ac;
                  } else {
                    ab.flashvars = ac;
                  }
                  if (M.ie && M.win && ae.readyState != 4) {
                    var Y = C("div");
                    X += "SWFObjectNew";
                    Y.setAttribute("id", X);
                    ae.parentNode.insertBefore(Y, ae);
                    ae.style.display = "none";
                    (function() {
                      if (ae.readyState == 4) {
                        ae.parentNode.removeChild(ae);
                      } else {
                        setTimeout(arguments.callee, 10);
                      }
                    })();
                  }
                  u(aa, ab, X);
                }
              }
              function p(Y) {
                if (M.ie && M.win && Y.readyState != 4) {
                  var X = C("div");
                  Y.parentNode.insertBefore(X, Y);
                  X.parentNode.replaceChild(g(Y), X);
                  Y.style.display = "none";
                  (function() {
                    if (Y.readyState == 4) {
                      Y.parentNode.removeChild(Y);
                    } else {
                      setTimeout(arguments.callee, 10);
                    }
                  })();
                } else {
                  Y.parentNode.replaceChild(g(Y), Y);
                }
              }
              function g(ab) {
                var aa = C("div");
                if (M.win && M.ie) {
                  aa.innerHTML = ab.innerHTML;
                } else {
                  var Y = ab.getElementsByTagName(r)[0];
                  if (Y) {
                    var ad = Y.childNodes;
                    if (ad) {
                      var X = ad.length;
                      for (var Z = 0; Z < X; Z++) {
                        if (
                          !(ad[Z].nodeType == 1 && ad[Z].nodeName == "PARAM") &&
                          !(ad[Z].nodeType == 8)
                        ) {
                          aa.appendChild(ad[Z].cloneNode(true));
                        }
                      }
                    }
                  }
                }
                return aa;
              }
              function u(ai, ag, Y) {
                var X,
                  aa = c(Y);
                if (M.wk && M.wk < 312) {
                  return X;
                }
                if (aa) {
                  if (typeof ai.id == D) {
                    ai.id = Y;
                  }
                  if (M.ie && M.win) {
                    var ah = "";
                    for (var ae in ai) {
                      if (ai[ae] != Object.prototype[ae]) {
                        if (ae.toLowerCase() == "data") {
                          ag.movie = ai[ae];
                        } else {
                          if (ae.toLowerCase() == "styleclass") {
                            ah += ' class="' + ai[ae] + '"';
                          } else {
                            if (ae.toLowerCase() != "classid") {
                              ah += " " + ae + '="' + ai[ae] + '"';
                            }
                          }
                        }
                      }
                    }
                    var af = "";
                    for (var ad in ag) {
                      if (ag[ad] != Object.prototype[ad]) {
                        af +=
                          '<param name="' + ad + '" value="' + ag[ad] + '" />';
                      }
                    }
                    aa.outerHTML =
                      '<object classid="clsid:D27CDB6E-AE6D-11cf-96B8-444553540000"' +
                      ah +
                      ">" +
                      af +
                      "</object>";
                    N[N.length] = ai.id;
                    X = c(ai.id);
                  } else {
                    var Z = C(r);
                    Z.setAttribute("type", q);
                    for (var ac in ai) {
                      if (ai[ac] != Object.prototype[ac]) {
                        if (ac.toLowerCase() == "styleclass") {
                          Z.setAttribute("class", ai[ac]);
                        } else {
                          if (ac.toLowerCase() != "classid") {
                            Z.setAttribute(ac, ai[ac]);
                          }
                        }
                      }
                    }
                    for (var ab in ag) {
                      if (
                        ag[ab] != Object.prototype[ab] &&
                        ab.toLowerCase() != "movie"
                      ) {
                        e(Z, ab, ag[ab]);
                      }
                    }
                    aa.parentNode.replaceChild(Z, aa);
                    X = Z;
                  }
                }
                return X;
              }
              function e(Z, X, Y) {
                var aa = C("param");
                aa.setAttribute("name", X);
                aa.setAttribute("value", Y);
                Z.appendChild(aa);
              }
              function y(Y) {
                var X = c(Y);
                if (X && X.nodeName == "OBJECT") {
                  if (M.ie && M.win) {
                    X.style.display = "none";
                    (function() {
                      if (X.readyState == 4) {
                        b(Y);
                      } else {
                        setTimeout(arguments.callee, 10);
                      }
                    })();
                  } else {
                    X.parentNode.removeChild(X);
                  }
                }
              }
              function b(Z) {
                var Y = c(Z);
                if (Y) {
                  for (var X in Y) {
                    if (typeof Y[X] == "function") {
                      Y[X] = null;
                    }
                  }
                  Y.parentNode.removeChild(Y);
                }
              }
              function c(Z) {
                var X = null;
                try {
                  X = j.getElementById(Z);
                } catch (Y) {}
                return X;
              }
              function C(X) {
                return j.createElement(X);
              }
              function i(Z, X, Y) {
                Z.attachEvent(X, Y);
                I[I.length] = [Z, X, Y];
              }
              function F(Z) {
                var Y = M.pv,
                  X = Z.split(".");
                X[0] = parseInt(X[0], 10);
                X[1] = parseInt(X[1], 10) || 0;
                X[2] = parseInt(X[2], 10) || 0;
                return Y[0] > X[0] ||
                  (Y[0] == X[0] && Y[1] > X[1]) ||
                  (Y[0] == X[0] && Y[1] == X[1] && Y[2] >= X[2])
                  ? true
                  : false;
              }
              function v(ac, Y, ad, ab) {
                if (M.ie && M.mac) {
                  return;
                }
                var aa = j.getElementsByTagName("head")[0];
                if (!aa) {
                  return;
                }
                var X = ad && typeof ad == "string" ? ad : "screen";
                if (ab) {
                  n = null;
                  G = null;
                }
                if (!n || G != X) {
                  var Z = C("style");
                  Z.setAttribute("type", "text/css");
                  Z.setAttribute("media", X);
                  n = aa.appendChild(Z);
                  if (
                    M.ie &&
                    M.win &&
                    typeof j.styleSheets != D &&
                    j.styleSheets.length > 0
                  ) {
                    n = j.styleSheets[j.styleSheets.length - 1];
                  }
                  G = X;
                }
                if (M.ie && M.win) {
                  if (n && typeof n.addRule == r) {
                    n.addRule(ac, Y);
                  }
                } else {
                  if (n && typeof j.createTextNode != D) {
                    n.appendChild(j.createTextNode(ac + " {" + Y + "}"));
                  }
                }
              }
              function w(Z, X) {
                if (!m) {
                  return;
                }
                var Y = X ? "visible" : "hidden";
                if (J && c(Z)) {
                  c(Z).style.visibility = Y;
                } else {
                  v("#" + Z, "visibility:" + Y);
                }
              }
              function L(Y) {
                var Z = /[\\\"<>\.;]/;
                var X = Z.exec(Y) != null;
                return X && typeof encodeURIComponent != D
                  ? encodeURIComponent(Y)
                  : Y;
              }
              var d = (function() {
                if (M.ie && M.win) {
                  window.attachEvent("onunload", function() {
                    var ac = I.length;
                    for (var ab = 0; ab < ac; ab++) {
                      I[ab][0].detachEvent(I[ab][1], I[ab][2]);
                    }
                    var Z = N.length;
                    for (var aa = 0; aa < Z; aa++) {
                      y(N[aa]);
                    }
                    for (var Y in M) {
                      M[Y] = null;
                    }
                    M = null;
                    for (var X in swfobject) {
                      swfobject[X] = null;
                    }
                    swfobject = null;
                  });
                }
              })();
              return {
                registerObject: function(ab, X, aa, Z) {
                  if (M.w3 && ab && X) {
                    var Y = {};
                    Y.id = ab;
                    Y.swfVersion = X;
                    Y.expressInstall = aa;
                    Y.callbackFn = Z;
                    o[o.length] = Y;
                    w(ab, false);
                  } else {
                    if (Z) {
                      Z({ success: false, id: ab });
                    }
                  }
                },
                getObjectById: function(X) {
                  if (M.w3) {
                    return z(X);
                  }
                },
                embedSWF: function(ab, ah, ae, ag, Y, aa, Z, ad, af, ac) {
                  var X = { success: false, id: ah };
                  if (
                    M.w3 &&
                    !(M.wk && M.wk < 312) &&
                    ab &&
                    ah &&
                    ae &&
                    ag &&
                    Y
                  ) {
                    w(ah, false);
                    K(function() {
                      ae += "";
                      ag += "";
                      var aj = {};
                      if (af && typeof af === r) {
                        for (var al in af) {
                          aj[al] = af[al];
                        }
                      }
                      aj.data = ab;
                      aj.width = ae;
                      aj.height = ag;
                      var am = {};
                      if (ad && typeof ad === r) {
                        for (var ak in ad) {
                          am[ak] = ad[ak];
                        }
                      }
                      if (Z && typeof Z === r) {
                        for (var ai in Z) {
                          if (typeof am.flashvars != D) {
                            am.flashvars += "&" + ai + "=" + Z[ai];
                          } else {
                            am.flashvars = ai + "=" + Z[ai];
                          }
                        }
                      }
                      if (F(Y)) {
                        var an = u(aj, am, ah);
                        if (aj.id == ah) {
                          w(ah, true);
                        }
                        X.success = true;
                        X.ref = an;
                      } else {
                        if (aa && A()) {
                          aj.data = aa;
                          P(aj, am, ah, ac);
                          return;
                        } else {
                          w(ah, true);
                        }
                      }
                      if (ac) {
                        ac(X);
                      }
                    });
                  } else {
                    if (ac) {
                      ac(X);
                    }
                  }
                },
                switchOffAutoHideShow: function() {
                  m = false;
                },
                ua: M,
                getFlashPlayerVersion: function() {
                  return { major: M.pv[0], minor: M.pv[1], release: M.pv[2] };
                },
                hasFlashPlayerVersion: F,
                createSWF: function(Z, Y, X) {
                  if (M.w3) {
                    return u(Z, Y, X);
                  } else {
                    return undefined;
                  }
                },
                showExpressInstall: function(Z, aa, X, Y) {
                  if (M.w3 && A()) {
                    P(Z, aa, X, Y);
                  }
                },
                removeSWF: function(X) {
                  if (M.w3) {
                    y(X);
                  }
                },
                createCSS: function(aa, Z, Y, X) {
                  if (M.w3) {
                    v(aa, Z, Y, X);
                  }
                },
                addDomLoadEvent: K,
                addLoadEvent: s,
                getQueryParamValue: function(aa) {
                  var Z = j.location.search || j.location.hash;
                  if (Z) {
                    if (/\?/.test(Z)) {
                      Z = Z.split("?")[1];
                    }
                    if (aa == null) {
                      return L(Z);
                    }
                    var Y = Z.split("&");
                    for (var X = 0; X < Y.length; X++) {
                      if (Y[X].substring(0, Y[X].indexOf("=")) == aa) {
                        return L(Y[X].substring(Y[X].indexOf("=") + 1));
                      }
                    }
                  }
                  return "";
                },
                expressInstallCallback: function() {
                  if (a) {
                    var X = c(R);
                    if (X && l) {
                      X.parentNode.replaceChild(l, X);
                      if (Q) {
                        w(Q, true);
                        if (M.ie && M.win) {
                          l.style.display = "block";
                        }
                      }
                      if (E) {
                        E(B);
                      }
                    }
                    a = false;
                  }
                }
              };
            })();
          }
          // Copyright: Hiroshi Ichikawa <http://gimite.net/en/>
          // License: New BSD License
          // Reference: http://dev.w3.org/html5/websockets/
          // Reference: http://tools.ietf.org/html/draft-hixie-thewebsocketprotocol

          (function() {
            if ("undefined" == typeof window || window.WebSocket) return;

            var console = window.console;
            if (!console || !console.log || !console.error) {
              console = { log: function() {}, error: function() {} };
            }

            if (!swfobject.hasFlashPlayerVersion("10.0.0")) {
              console.error("Flash Player >= 10.0.0 is required.");
              return;
            }
            if (location.protocol == "file:") {
              console.error(
                "WARNING: web-socket-js doesn't work in file:///... URL " +
                  "unless you set Flash Security Settings properly. " +
                  "Open the page via Web server i.e. http://..."
              );
            }

            /**
             * This class represents a faux web socket.
             * @param {string} url
             * @param {array or string} protocols
             * @param {string} proxyHost
             * @param {int} proxyPort
             * @param {string} headers
             */
            WebSocket = function(
              url,
              protocols,
              proxyHost,
              proxyPort,
              headers
            ) {
              var self = this;
              self.__id = WebSocket.__nextId++;
              WebSocket.__instances[self.__id] = self;
              self.readyState = WebSocket.CONNECTING;
              self.bufferedAmount = 0;
              self.__events = {};
              if (!protocols) {
                protocols = [];
              } else if (typeof protocols == "string") {
                protocols = [protocols];
              }
              // Uses setTimeout() to make sure __createFlash() runs after the caller sets ws.onopen etc.
              // Otherwise, when onopen fires immediately, onopen is called before it is set.
              setTimeout(function() {
                WebSocket.__addTask(function() {
                  WebSocket.__flash.create(
                    self.__id,
                    url,
                    protocols,
                    proxyHost || null,
                    proxyPort || 0,
                    headers || null
                  );
                });
              }, 0);
            };

            /**
             * Send data to the web socket.
             * @param {string} data  The data to send to the socket.
             * @return {boolean}  True for success, false for failure.
             */
            WebSocket.prototype.send = function(data) {
              if (this.readyState == WebSocket.CONNECTING) {
                throw "INVALID_STATE_ERR: Web Socket connection has not been established";
              }
              // We use encodeURIComponent() here, because FABridge doesn't work if
              // the argument includes some characters. We don't use escape() here
              // because of this:
              // https://developer.mozilla.org/en/Core_JavaScript_1.5_Guide/Functions#escape_and_unescape_Functions
              // But it looks decodeURIComponent(encodeURIComponent(s)) doesn't
              // preserve all Unicode characters either e.g. "\uffff" in Firefox.
              // Note by wtritch: Hopefully this will not be necessary using ExternalInterface.  Will require
              // additional testing.
              var result = WebSocket.__flash.send(
                this.__id,
                encodeURIComponent(data)
              );
              if (result < 0) {
                // success
                return true;
              } else {
                this.bufferedAmount += result;
                return false;
              }
            };

            /**
             * Close this web socket gracefully.
             */
            WebSocket.prototype.close = function() {
              if (
                this.readyState == WebSocket.CLOSED ||
                this.readyState == WebSocket.CLOSING
              ) {
                return;
              }
              this.readyState = WebSocket.CLOSING;
              WebSocket.__flash.close(this.__id);
            };

            /**
             * Implementation of {@link <a href="http://www.w3.org/TR/DOM-Level-2-Events/events.html#Events-registration">DOM 2 EventTarget Interface</a>}
             *
             * @param {string} type
             * @param {function} listener
             * @param {boolean} useCapture
             * @return void
             */
            WebSocket.prototype.addEventListener = function(
              type,
              listener,
              useCapture
            ) {
              if (!(type in this.__events)) {
                this.__events[type] = [];
              }
              this.__events[type].push(listener);
            };

            /**
             * Implementation of {@link <a href="http://www.w3.org/TR/DOM-Level-2-Events/events.html#Events-registration">DOM 2 EventTarget Interface</a>}
             *
             * @param {string} type
             * @param {function} listener
             * @param {boolean} useCapture
             * @return void
             */
            WebSocket.prototype.removeEventListener = function(
              type,
              listener,
              useCapture
            ) {
              if (!(type in this.__events)) return;
              var events = this.__events[type];
              for (var i = events.length - 1; i >= 0; --i) {
                if (events[i] === listener) {
                  events.splice(i, 1);
                  break;
                }
              }
            };

            /**
             * Implementation of {@link <a href="http://www.w3.org/TR/DOM-Level-2-Events/events.html#Events-registration">DOM 2 EventTarget Interface</a>}
             *
             * @param {Event} event
             * @return void
             */
            WebSocket.prototype.dispatchEvent = function(event) {
              var events = this.__events[event.type] || [];
              for (var i = 0; i < events.length; ++i) {
                events[i](event);
              }
              var handler = this["on" + event.type];
              if (handler) handler(event);
            };

            /**
             * Handles an event from Flash.
             * @param {Object} flashEvent
             */
            WebSocket.prototype.__handleEvent = function(flashEvent) {
              if ("readyState" in flashEvent) {
                this.readyState = flashEvent.readyState;
              }
              if ("protocol" in flashEvent) {
                this.protocol = flashEvent.protocol;
              }

              var jsEvent;
              if (flashEvent.type == "open" || flashEvent.type == "error") {
                jsEvent = this.__createSimpleEvent(flashEvent.type);
              } else if (flashEvent.type == "close") {
                // TODO implement jsEvent.wasClean
                jsEvent = this.__createSimpleEvent("close");
              } else if (flashEvent.type == "message") {
                var data = decodeURIComponent(flashEvent.message);
                jsEvent = this.__createMessageEvent("message", data);
              } else {
                throw "unknown event type: " + flashEvent.type;
              }

              this.dispatchEvent(jsEvent);
            };

            WebSocket.prototype.__createSimpleEvent = function(type) {
              if (document.createEvent && window.Event) {
                var event = document.createEvent("Event");
                event.initEvent(type, false, false);
                return event;
              } else {
                return { type: type, bubbles: false, cancelable: false };
              }
            };

            WebSocket.prototype.__createMessageEvent = function(type, data) {
              if (
                document.createEvent &&
                window.MessageEvent &&
                !window.opera
              ) {
                var event = document.createEvent("MessageEvent");
                event.initMessageEvent(
                  "message",
                  false,
                  false,
                  data,
                  null,
                  null,
                  window,
                  null
                );
                return event;
              } else {
                // IE and Opera, the latter one truncates the data parameter after any 0x00 bytes.
                return {
                  type: type,
                  data: data,
                  bubbles: false,
                  cancelable: false
                };
              }
            };

            /**
             * Define the WebSocket readyState enumeration.
             */
            WebSocket.CONNECTING = 0;
            WebSocket.OPEN = 1;
            WebSocket.CLOSING = 2;
            WebSocket.CLOSED = 3;

            WebSocket.__flash = null;
            WebSocket.__instances = {};
            WebSocket.__tasks = [];
            WebSocket.__nextId = 0;

            /**
             * Load a new flash security policy file.
             * @param {string} url
             */
            WebSocket.loadFlashPolicyFile = function(url) {
              WebSocket.__addTask(function() {
                WebSocket.__flash.loadManualPolicyFile(url);
              });
            };

            /**
             * Loads WebSocketMain.swf and creates WebSocketMain object in Flash.
             */
            WebSocket.__initialize = function() {
              if (WebSocket.__flash) return;

              if (WebSocket.__swfLocation) {
                // For backword compatibility.
                window.WEB_SOCKET_SWF_LOCATION = WebSocket.__swfLocation;
              }
              if (!window.WEB_SOCKET_SWF_LOCATION) {
                console.error(
                  "[WebSocket] set WEB_SOCKET_SWF_LOCATION to location of WebSocketMain.swf"
                );
                return;
              }
              var container = document.createElement("div");
              container.id = "webSocketContainer";
              // Hides Flash box. We cannot use display: none or visibility: hidden because it prevents
              // Flash from loading at least in IE. So we move it out of the screen at (-100, -100).
              // But this even doesn't work with Flash Lite (e.g. in Droid Incredible). So with Flash
              // Lite, we put it at (0, 0). This shows 1x1 box visible at left-top corner but this is
              // the best we can do as far as we know now.
              container.style.position = "absolute";
              if (WebSocket.__isFlashLite()) {
                container.style.left = "0px";
                container.style.top = "0px";
              } else {
                container.style.left = "-100px";
                container.style.top = "-100px";
              }
              var holder = document.createElement("div");
              holder.id = "webSocketFlash";
              container.appendChild(holder);
              document.body.appendChild(container);
              // See this article for hasPriority:
              // http://help.adobe.com/en_US/as3/mobile/WS4bebcd66a74275c36cfb8137124318eebc6-7ffd.html
              swfobject.embedSWF(
                WEB_SOCKET_SWF_LOCATION,
                "webSocketFlash",
                "1" /* width */,
                "1" /* height */,
                "10.0.0" /* SWF version */,
                null,
                null,
                {
                  hasPriority: true,
                  swliveconnect: true,
                  allowScriptAccess: "always"
                },
                null,
                function(e) {
                  if (!e.success) {
                    console.error("[WebSocket] swfobject.embedSWF failed");
                  }
                }
              );
            };

            /**
             * Called by Flash to notify JS that it's fully loaded and ready
             * for communication.
             */
            WebSocket.__onFlashInitialized = function() {
              // We need to set a timeout here to avoid round-trip calls
              // to flash during the initialization process.
              setTimeout(function() {
                WebSocket.__flash = document.getElementById("webSocketFlash");
                WebSocket.__flash.setCallerUrl(location.href);
                WebSocket.__flash.setDebug(!!window.WEB_SOCKET_DEBUG);
                for (var i = 0; i < WebSocket.__tasks.length; ++i) {
                  WebSocket.__tasks[i]();
                }
                WebSocket.__tasks = [];
              }, 0);
            };

            /**
             * Called by Flash to notify WebSockets events are fired.
             */
            WebSocket.__onFlashEvent = function() {
              setTimeout(function() {
                try {
                  // Gets events using receiveEvents() instead of getting it from event object
                  // of Flash event. This is to make sure to keep message order.
                  // It seems sometimes Flash events don't arrive in the same order as they are sent.
                  var events = WebSocket.__flash.receiveEvents();
                  for (var i = 0; i < events.length; ++i) {
                    WebSocket.__instances[events[i].webSocketId].__handleEvent(
                      events[i]
                    );
                  }
                } catch (e) {
                  console.error(e);
                }
              }, 0);
              return true;
            };

            // Called by Flash.
            WebSocket.__log = function(message) {
              console.log(decodeURIComponent(message));
            };

            // Called by Flash.
            WebSocket.__error = function(message) {
              console.error(decodeURIComponent(message));
            };

            WebSocket.__addTask = function(task) {
              if (WebSocket.__flash) {
                task();
              } else {
                WebSocket.__tasks.push(task);
              }
            };

            /**
             * Test if the browser is running flash lite.
             * @return {boolean} True if flash lite is running, false otherwise.
             */
            WebSocket.__isFlashLite = function() {
              if (!window.navigator || !window.navigator.mimeTypes) {
                return false;
              }
              var mimeType =
                window.navigator.mimeTypes["application/x-shockwave-flash"];
              if (
                !mimeType ||
                !mimeType.enabledPlugin ||
                !mimeType.enabledPlugin.filename
              ) {
                return false;
              }
              return mimeType.enabledPlugin.filename.match(/flashlite/i)
                ? true
                : false;
            };

            if (!window.WEB_SOCKET_DISABLE_AUTO_INITIALIZATION) {
              if (window.addEventListener) {
                window.addEventListener(
                  "load",
                  function() {
                    WebSocket.__initialize();
                  },
                  false
                );
              } else {
                window.attachEvent("onload", function() {
                  WebSocket.__initialize();
                });
              }
            }
          })();

          /**
           * socket.io
           * Copyright(c) 2011 LearnBoost <dev@learnboost.com>
           * MIT Licensed
           */

          (function(exports, io, global) {
            /**
             * Expose constructor.
             *
             * @api public
             */

            exports.XHR = XHR;

            /**
             * XHR constructor
             *
             * @costructor
             * @api public
             */

            function XHR(socket) {
              if (!socket) return;

              io.Transport.apply(this, arguments);
              this.sendBuffer = [];
            }

            /**
             * Inherits from Transport.
             */

            io.util.inherit(XHR, io.Transport);

            /**
             * Establish a connection
             *
             * @returns {Transport}
             * @api public
             */

            XHR.prototype.open = function() {
              this.socket.setBuffer(false);
              this.onOpen();
              this.get();

              // we need to make sure the request succeeds since we have no indication
              // whether the request opened or not until it succeeded.
              this.setCloseTimeout();

              return this;
            };

            /**
             * Check if we need to send data to the Socket.IO server, if we have data in our
             * buffer we encode it and forward it to the `post` method.
             *
             * @api private
             */

            XHR.prototype.payload = function(payload) {
              var msgs = [];

              for (var i = 0, l = payload.length; i < l; i++) {
                msgs.push(io.parser.encodePacket(payload[i]));
              }

              this.send(io.parser.encodePayload(msgs));
            };

            /**
             * Send data to the Socket.IO server.
             *
             * @param data The message
             * @returns {Transport}
             * @api public
             */

            XHR.prototype.send = function(data) {
              this.post(data);
              return this;
            };

            /**
             * Posts a encoded message to the Socket.IO server.
             *
             * @param {String} data A encoded message.
             * @api private
             */

            function empty() {}

            XHR.prototype.post = function(data) {
              var self = this;
              this.socket.setBuffer(true);

              function stateChange() {
                if (this.readyState == 4) {
                  this.onreadystatechange = empty;
                  self.posting = false;

                  if (this.status == 200) {
                    self.socket.setBuffer(false);
                  } else {
                    self.onClose();
                  }
                }
              }

              function onload() {
                this.onload = empty;
                self.socket.setBuffer(false);
              }

              this.sendXHR = this.request("POST");

              if (
                global.XDomainRequest &&
                this.sendXHR instanceof XDomainRequest
              ) {
                this.sendXHR.onload = this.sendXHR.onerror = onload;
              } else {
                this.sendXHR.onreadystatechange = stateChange;
              }

              this.sendXHR.send(data);
            };

            /**
             * Disconnects the established `XHR` connection.
             *
             * @returns {Transport}
             * @api public
             */

            XHR.prototype.close = function() {
              this.onClose();
              return this;
            };

            /**
             * Generates a configured XHR request
             *
             * @param {String} url The url that needs to be requested.
             * @param {String} method The method the request should use.
             * @returns {XMLHttpRequest}
             * @api private
             */

            XHR.prototype.request = function(method) {
              var req = io.util.request(this.socket.isXDomain()),
                query = io.util.query(
                  this.socket.options.query,
                  "t=" + +new Date()
                );

              req.open(method || "GET", this.prepareUrl() + query, true);

              if (method == "POST") {
                try {
                  if (req.setRequestHeader) {
                    req.setRequestHeader(
                      "Content-type",
                      "text/plain;charset=UTF-8"
                    );
                  } else {
                    // XDomainRequest
                    req.contentType = "text/plain";
                  }
                } catch (e) {}
              }

              return req;
            };

            /**
             * Returns the scheme to use for the transport URLs.
             *
             * @api private
             */

            XHR.prototype.scheme = function() {
              return this.socket.options.secure ? "https" : "http";
            };

            /**
             * Check if the XHR transports are supported
             *
             * @param {Boolean} xdomain Check if we support cross domain requests.
             * @returns {Boolean}
             * @api public
             */

            XHR.check = function(socket, xdomain) {
              try {
                var request = io.util.request(xdomain),
                  usesXDomReq =
                    global.XDomainRequest && request instanceof XDomainRequest,
                  socketProtocol =
                    socket && socket.options && socket.options.secure
                      ? "https:"
                      : "http:",
                  isXProtocol =
                    global.location &&
                    socketProtocol != global.location.protocol;
                if (request && !(usesXDomReq && isXProtocol)) {
                  return true;
                }
              } catch (e) {}

              return false;
            };

            /**
             * Check if the XHR transport supports cross domain requests.
             *
             * @returns {Boolean}
             * @api public
             */

            XHR.xdomainCheck = function(socket) {
              return XHR.check(socket, true);
            };
          })(
            "undefined" != typeof io ? io.Transport : module.exports,
            "undefined" != typeof io ? io : module.parent.exports,
            this
          );
          /**
           * socket.io
           * Copyright(c) 2011 LearnBoost <dev@learnboost.com>
           * MIT Licensed
           */

          (function(exports, io) {
            /**
             * Expose constructor.
             */

            exports.htmlfile = HTMLFile;

            /**
             * The HTMLFile transport creates a `forever iframe` based transport
             * for Internet Explorer. Regular forever iframe implementations will
             * continuously trigger the browsers buzy indicators. If the forever iframe
             * is created inside a `htmlfile` these indicators will not be trigged.
             *
             * @constructor
             * @extends {io.Transport.XHR}
             * @api public
             */

            function HTMLFile(socket) {
              io.Transport.XHR.apply(this, arguments);
            }

            /**
             * Inherits from XHR transport.
             */

            io.util.inherit(HTMLFile, io.Transport.XHR);

            /**
             * Transport name
             *
             * @api public
             */

            HTMLFile.prototype.name = "htmlfile";

            /**
             * Creates a new Ac...eX `htmlfile` with a forever loading iframe
             * that can be used to listen to messages. Inside the generated
             * `htmlfile` a reference will be made to the HTMLFile transport.
             *
             * @api private
             */

            HTMLFile.prototype.get = function() {
              this.doc = new window[["Active"].concat("Object").join("X")](
                "htmlfile"
              );
              this.doc.open();
              this.doc.write("<html></html>");
              this.doc.close();
              this.doc.parentWindow.s = this;

              var iframeC = this.doc.createElement("div");
              iframeC.className = "socketio";

              this.doc.body.appendChild(iframeC);
              this.iframe = this.doc.createElement("iframe");

              iframeC.appendChild(this.iframe);

              var self = this,
                query = io.util.query(
                  this.socket.options.query,
                  "t=" + +new Date()
                );

              this.iframe.src = this.prepareUrl() + query;

              io.util.on(window, "unload", function() {
                self.destroy();
              });
            };

            /**
             * The Socket.IO server will write script tags inside the forever
             * iframe, this function will be used as callback for the incoming
             * information.
             *
             * @param {String} data The message
             * @param {document} doc Reference to the context
             * @api private
             */

            HTMLFile.prototype._ = function(data, doc) {
              // unescape all forward slashes. see GH-1251
              data = data.replace(/\\\//g, "/");
              this.onData(data);
              try {
                var script = doc.getElementsByTagName("script")[0];
                script.parentNode.removeChild(script);
              } catch (e) {}
            };

            /**
             * Destroy the established connection, iframe and `htmlfile`.
             * And calls the `CollectGarbage` function of Internet Explorer
             * to release the memory.
             *
             * @api private
             */

            HTMLFile.prototype.destroy = function() {
              if (this.iframe) {
                try {
                  this.iframe.src = "about:blank";
                } catch (e) {}

                this.doc = null;
                this.iframe.parentNode.removeChild(this.iframe);
                this.iframe = null;

                CollectGarbage();
              }
            };

            /**
             * Disconnects the established connection.
             *
             * @returns {Transport} Chaining.
             * @api public
             */

            HTMLFile.prototype.close = function() {
              this.destroy();
              return io.Transport.XHR.prototype.close.call(this);
            };

            /**
             * Checks if the browser supports this transport. The browser
             * must have an `Ac...eXObject` implementation.
             *
             * @return {Boolean}
             * @api public
             */

            HTMLFile.check = function(socket) {
              if (
                typeof window != "undefined" &&
                ["Active"].concat("Object").join("X") in window
              ) {
                try {
                  var a = new window[["Active"].concat("Object").join("X")](
                    "htmlfile"
                  );
                  return a && io.Transport.XHR.check(socket);
                } catch (e) {}
              }
              return false;
            };

            /**
             * Check if cross domain requests are supported.
             *
             * @returns {Boolean}
             * @api public
             */

            HTMLFile.xdomainCheck = function() {
              // we can probably do handling for sub-domains, we should
              // test that it's cross domain but a subdomain here
              return false;
            };

            /**
             * Add the transport to your public io.transports array.
             *
             * @api private
             */

            io.transports.push("htmlfile");
          })(
            "undefined" != typeof io ? io.Transport : module.exports,
            "undefined" != typeof io ? io : module.parent.exports
          );

          /**
           * socket.io
           * Copyright(c) 2011 LearnBoost <dev@learnboost.com>
           * MIT Licensed
           */

          (function(exports, io, global) {
            /**
             * Expose constructor.
             */

            exports["xhr-polling"] = XHRPolling;

            /**
             * The XHR-polling transport uses long polling XHR requests to create a
             * "persistent" connection with the server.
             *
             * @constructor
             * @api public
             */

            function XHRPolling() {
              io.Transport.XHR.apply(this, arguments);
            }

            /**
             * Inherits from XHR transport.
             */

            io.util.inherit(XHRPolling, io.Transport.XHR);

            /**
             * Merge the properties from XHR transport
             */

            io.util.merge(XHRPolling, io.Transport.XHR);

            /**
             * Transport name
             *
             * @api public
             */

            XHRPolling.prototype.name = "xhr-polling";

            /**
             * Indicates whether heartbeats is enabled for this transport
             *
             * @api private
             */

            XHRPolling.prototype.heartbeats = function() {
              return false;
            };

            /**
             * Establish a connection, for iPhone and Android this will be done once the page
             * is loaded.
             *
             * @returns {Transport} Chaining.
             * @api public
             */

            XHRPolling.prototype.open = function() {
              var self = this;

              io.Transport.XHR.prototype.open.call(self);
              return false;
            };

            /**
             * Starts a XHR request to wait for incoming messages.
             *
             * @api private
             */

            function empty() {}

            XHRPolling.prototype.get = function() {
              if (!this.isOpen) return;

              var self = this;

              function stateChange() {
                if (this.readyState == 4) {
                  this.onreadystatechange = empty;

                  if (this.status == 200) {
                    self.onData(this.responseText);
                    self.get();
                  } else {
                    self.onClose();
                  }
                }
              }

              function onload() {
                this.onload = empty;
                this.onerror = empty;
                self.retryCounter = 1;
                self.onData(this.responseText);
                self.get();
              }

              function onerror() {
                self.retryCounter++;
                if (!self.retryCounter || self.retryCounter > 3) {
                  self.onClose();
                } else {
                  self.get();
                }
              }

              this.xhr = this.request();

              if (global.XDomainRequest && this.xhr instanceof XDomainRequest) {
                this.xhr.onload = onload;
                this.xhr.onerror = onerror;
              } else {
                this.xhr.onreadystatechange = stateChange;
              }

              this.xhr.send(null);
            };

            /**
             * Handle the unclean close behavior.
             *
             * @api private
             */

            XHRPolling.prototype.onClose = function() {
              io.Transport.XHR.prototype.onClose.call(this);

              if (this.xhr) {
                this.xhr.onreadystatechange = this.xhr.onload = this.xhr.onerror = empty;
                try {
                  this.xhr.abort();
                } catch (e) {}
                this.xhr = null;
              }
            };

            /**
             * Webkit based browsers show a infinit spinner when you start a XHR request
             * before the browsers onload event is called so we need to defer opening of
             * the transport until the onload event is called. Wrapping the cb in our
             * defer method solve this.
             *
             * @param {Socket} socket The socket instance that needs a transport
             * @param {Function} fn The callback
             * @api private
             */

            XHRPolling.prototype.ready = function(socket, fn) {
              var self = this;

              io.util.defer(function() {
                fn.call(self);
              });
            };

            /**
             * Add the transport to your public io.transports array.
             *
             * @api private
             */

            io.transports.push("xhr-polling");
          })(
            "undefined" != typeof io ? io.Transport : module.exports,
            "undefined" != typeof io ? io : module.parent.exports,
            this
          );

          /**
           * socket.io
           * Copyright(c) 2011 LearnBoost <dev@learnboost.com>
           * MIT Licensed
           */

          (function(exports, io, global) {
            /**
             * There is a way to hide the loading indicator in Firefox. If you create and
             * remove a iframe it will stop showing the current loading indicator.
             * Unfortunately we can't feature detect that and UA sniffing is evil.
             *
             * @api private
             */

            var indicator =
              global.document &&
              "MozAppearance" in global.document.documentElement.style;

            /**
             * Expose constructor.
             */

            exports["jsonp-polling"] = JSONPPolling;

            /**
             * The JSONP transport creates an persistent connection by dynamically
             * inserting a script tag in the page. This script tag will receive the
             * information of the Socket.IO server. When new information is received
             * it creates a new script tag for the new data stream.
             *
             * @constructor
             * @extends {io.Transport.xhr-polling}
             * @api public
             */

            function JSONPPolling(socket) {
              io.Transport["xhr-polling"].apply(this, arguments);

              this.index = io.j.length;

              var self = this;

              io.j.push(function(msg) {
                self._(msg);
              });
            }

            /**
             * Inherits from XHR polling transport.
             */

            io.util.inherit(JSONPPolling, io.Transport["xhr-polling"]);

            /**
             * Transport name
             *
             * @api public
             */

            JSONPPolling.prototype.name = "jsonp-polling";

            /**
             * Posts a encoded message to the Socket.IO server using an iframe.
             * The iframe is used because script tags can create POST based requests.
             * The iframe is positioned outside of the view so the user does not
             * notice it's existence.
             *
             * @param {String} data A encoded message.
             * @api private
             */

            JSONPPolling.prototype.post = function(data) {
              var self = this,
                query = io.util.query(
                  this.socket.options.query,
                  "t=" + +new Date() + "&i=" + this.index
                );

              if (!this.form) {
                var form = document.createElement("form"),
                  area = document.createElement("textarea"),
                  id = (this.iframeId = "socketio_iframe_" + this.index),
                  iframe;

                form.className = "socketio";
                form.style.position = "absolute";
                form.style.top = "0px";
                form.style.left = "0px";
                form.style.display = "none";
                form.target = id;
                form.method = "POST";
                form.setAttribute("accept-charset", "utf-8");
                area.name = "d";
                form.appendChild(area);
                document.body.appendChild(form);

                this.form = form;
                this.area = area;
              }

              this.form.action = this.prepareUrl() + query;

              function complete() {
                initIframe();
                self.socket.setBuffer(false);
              }

              function initIframe() {
                if (self.iframe) {
                  self.form.removeChild(self.iframe);
                }

                try {
                  // ie6 dynamic iframes with target="" support (thanks Chris Lambacher)
                  iframe = document.createElement(
                    '<iframe name="' + self.iframeId + '">'
                  );
                } catch (e) {
                  iframe = document.createElement("iframe");
                  iframe.name = self.iframeId;
                }

                iframe.id = self.iframeId;

                self.form.appendChild(iframe);
                self.iframe = iframe;
              }

              initIframe();

              // we temporarily stringify until we figure out how to prevent
              // browsers from turning `\n` into `\r\n` in form inputs
              this.area.value = io.JSON.stringify(data);

              try {
                this.form.submit();
              } catch (e) {}

              if (this.iframe.attachEvent) {
                iframe.onreadystatechange = function() {
                  if (self.iframe.readyState == "complete") {
                    complete();
                  }
                };
              } else {
                this.iframe.onload = complete;
              }

              this.socket.setBuffer(true);
            };

            /**
             * Creates a new JSONP poll that can be used to listen
             * for messages from the Socket.IO server.
             *
             * @api private
             */

            JSONPPolling.prototype.get = function() {
              var self = this,
                script = document.createElement("script"),
                query = io.util.query(
                  this.socket.options.query,
                  "t=" + +new Date() + "&i=" + this.index
                );

              if (this.script) {
                this.script.parentNode.removeChild(this.script);
                this.script = null;
              }

              script.async = true;
              script.src = this.prepareUrl() + query;
              script.onerror = function() {
                self.onClose();
              };

              var insertAt = document.getElementsByTagName("script")[0];
              insertAt.parentNode.insertBefore(script, insertAt);
              this.script = script;

              if (indicator) {
                setTimeout(function() {
                  var iframe = document.createElement("iframe");
                  document.body.appendChild(iframe);
                  document.body.removeChild(iframe);
                }, 100);
              }
            };

            /**
             * Callback function for the incoming message stream from the Socket.IO server.
             *
             * @param {String} data The message
             * @api private
             */

            JSONPPolling.prototype._ = function(msg) {
              this.onData(msg);
              if (this.isOpen) {
                this.get();
              }
              return this;
            };

            /**
             * The indicator hack only works after onload
             *
             * @param {Socket} socket The socket instance that needs a transport
             * @param {Function} fn The callback
             * @api private
             */

            JSONPPolling.prototype.ready = function(socket, fn) {
              var self = this;
              if (!indicator) return fn.call(this);

              io.util.load(function() {
                fn.call(self);
              });
            };

            /**
             * Checks if browser supports this transport.
             *
             * @return {Boolean}
             * @api public
             */

            JSONPPolling.check = function() {
              return "document" in global;
            };

            /**
             * Check if cross domain requests are supported
             *
             * @returns {Boolean}
             * @api public
             */

            JSONPPolling.xdomainCheck = function() {
              return true;
            };

            /**
             * Add the transport to your public io.transports array.
             *
             * @api private
             */

            io.transports.push("jsonp-polling");
          })(
            "undefined" != typeof io ? io.Transport : module.exports,
            "undefined" != typeof io ? io : module.parent.exports,
            this
          );

          if (typeof define === "function" && define.amd) {
            define([], function() {
              return io;
            });
          }
        })();
      },
      {}
    ],
    34: [
      function(require, module, exports) {
        const dnssd = require("../dnssd.js");

        // advertise a http server on port 4321
        //const ad = new dnssd.Advertisement(dnssd.tcp('http'), 4321);
        //ad.start();

        // find all chromecasts
        const browser = dnssd
          .Browser(dnssd.tcp("googlecast"))
          .on("serviceUp", service => console.log("Device up: ", service))
          .on("serviceDown", service => console.log("Device down: ", service))
          .start();
      },
      { "../dnssd.js": 1 }
    ],
    35: [
      function(require, module, exports) {
        "use strict";

        exports.byteLength = byteLength;
        exports.toByteArray = toByteArray;
        exports.fromByteArray = fromByteArray;

        var lookup = [];
        var revLookup = [];
        var Arr = typeof Uint8Array !== "undefined" ? Uint8Array : Array;

        var code =
          "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
        for (var i = 0, len = code.length; i < len; ++i) {
          lookup[i] = code[i];
          revLookup[code.charCodeAt(i)] = i;
        }

        // Support decoding URL-safe base64 strings, as Node.js does.
        // See: https://en.wikipedia.org/wiki/Base64#URL_applications
        revLookup["-".charCodeAt(0)] = 62;
        revLookup["_".charCodeAt(0)] = 63;

        function getLens(b64) {
          var len = b64.length;

          if (len % 4 > 0) {
            throw new Error("Invalid string. Length must be a multiple of 4");
          }

          // Trim off extra bytes after placeholder bytes are found
          // See: https://github.com/beatgammit/base64-js/issues/42
          var validLen = b64.indexOf("=");
          if (validLen === -1) validLen = len;

          var placeHoldersLen = validLen === len ? 0 : 4 - (validLen % 4);

          return [validLen, placeHoldersLen];
        }

        // base64 is 4/3 + up to two characters of the original data
        function byteLength(b64) {
          var lens = getLens(b64);
          var validLen = lens[0];
          var placeHoldersLen = lens[1];
          return ((validLen + placeHoldersLen) * 3) / 4 - placeHoldersLen;
        }

        function _byteLength(b64, validLen, placeHoldersLen) {
          return ((validLen + placeHoldersLen) * 3) / 4 - placeHoldersLen;
        }

        function toByteArray(b64) {
          var tmp;
          var lens = getLens(b64);
          var validLen = lens[0];
          var placeHoldersLen = lens[1];

          var arr = new Arr(_byteLength(b64, validLen, placeHoldersLen));

          var curByte = 0;

          // if there are placeholders, only get up to the last complete 4 chars
          var len = placeHoldersLen > 0 ? validLen - 4 : validLen;

          var i;
          for (i = 0; i < len; i += 4) {
            tmp =
              (revLookup[b64.charCodeAt(i)] << 18) |
              (revLookup[b64.charCodeAt(i + 1)] << 12) |
              (revLookup[b64.charCodeAt(i + 2)] << 6) |
              revLookup[b64.charCodeAt(i + 3)];
            arr[curByte++] = (tmp >> 16) & 0xff;
            arr[curByte++] = (tmp >> 8) & 0xff;
            arr[curByte++] = tmp & 0xff;
          }

          if (placeHoldersLen === 2) {
            tmp =
              (revLookup[b64.charCodeAt(i)] << 2) |
              (revLookup[b64.charCodeAt(i + 1)] >> 4);
            arr[curByte++] = tmp & 0xff;
          }

          if (placeHoldersLen === 1) {
            tmp =
              (revLookup[b64.charCodeAt(i)] << 10) |
              (revLookup[b64.charCodeAt(i + 1)] << 4) |
              (revLookup[b64.charCodeAt(i + 2)] >> 2);
            arr[curByte++] = (tmp >> 8) & 0xff;
            arr[curByte++] = tmp & 0xff;
          }

          return arr;
        }

        function tripletToBase64(num) {
          return (
            lookup[(num >> 18) & 0x3f] +
            lookup[(num >> 12) & 0x3f] +
            lookup[(num >> 6) & 0x3f] +
            lookup[num & 0x3f]
          );
        }

        function encodeChunk(uint8, start, end) {
          var tmp;
          var output = [];
          for (var i = start; i < end; i += 3) {
            tmp =
              ((uint8[i] << 16) & 0xff0000) +
              ((uint8[i + 1] << 8) & 0xff00) +
              (uint8[i + 2] & 0xff);
            output.push(tripletToBase64(tmp));
          }
          return output.join("");
        }

        function fromByteArray(uint8) {
          var tmp;
          var len = uint8.length;
          var extraBytes = len % 3; // if we have 1 byte left, pad 2 bytes
          var parts = [];
          var maxChunkLength = 16383; // must be multiple of 3

          // go through the array every three bytes, we'll deal with trailing stuff later
          for (
            var i = 0, len2 = len - extraBytes;
            i < len2;
            i += maxChunkLength
          ) {
            parts.push(
              encodeChunk(
                uint8,
                i,
                i + maxChunkLength > len2 ? len2 : i + maxChunkLength
              )
            );
          }

          // pad the end with zeros, but make sure to not forget the extra bytes
          if (extraBytes === 1) {
            tmp = uint8[len - 1];
            parts.push(lookup[tmp >> 2] + lookup[(tmp << 4) & 0x3f] + "==");
          } else if (extraBytes === 2) {
            tmp = (uint8[len - 2] << 8) + uint8[len - 1];
            parts.push(
              lookup[tmp >> 10] +
                lookup[(tmp >> 4) & 0x3f] +
                lookup[(tmp << 2) & 0x3f] +
                "="
            );
          }

          return parts.join("");
        }
      },
      {}
    ],
    36: [
      function(require, module, exports) {
        (function(Buffer) {
          /*!
           * The buffer module from node.js, for the browser.
           *
           * @author   Feross Aboukhadijeh <https://feross.org>
           * @license  MIT
           */
          /* eslint-disable no-proto */

          "use strict";

          var base64 = require("base64-js");
          var ieee754 = require("ieee754");

          exports.Buffer = Buffer;
          exports.SlowBuffer = SlowBuffer;
          exports.INSPECT_MAX_BYTES = 50;

          var K_MAX_LENGTH = 0x7fffffff;
          exports.kMaxLength = K_MAX_LENGTH;

          /**
           * If `Buffer.TYPED_ARRAY_SUPPORT`:
           *   === true    Use Uint8Array implementation (fastest)
           *   === false   Print warning and recommend using `buffer` v4.x which has an Object
           *               implementation (most compatible, even IE6)
           *
           * Browsers that support typed arrays are IE 10+, Firefox 4+, Chrome 7+, Safari 5.1+,
           * Opera 11.6+, iOS 4.2+.
           *
           * We report that the browser does not support typed arrays if the are not subclassable
           * using __proto__. Firefox 4-29 lacks support for adding new properties to `Uint8Array`
           * (See: https://bugzilla.mozilla.org/show_bug.cgi?id=695438). IE 10 lacks support
           * for __proto__ and has a buggy typed array implementation.
           */
          Buffer.TYPED_ARRAY_SUPPORT = typedArraySupport();

          if (
            !Buffer.TYPED_ARRAY_SUPPORT &&
            typeof console !== "undefined" &&
            typeof console.error === "function"
          ) {
            console.error(
              "This browser lacks typed array (Uint8Array) support which is required by " +
                "`buffer` v5.x. Use `buffer` v4.x if you require old browser support."
            );
          }

          function typedArraySupport() {
            // Can typed array instances can be augmented?
            try {
              var arr = new Uint8Array(1);
              arr.__proto__ = {
                __proto__: Uint8Array.prototype,
                foo: function() {
                  return 42;
                }
              };
              return arr.foo() === 42;
            } catch (e) {
              return false;
            }
          }

          Object.defineProperty(Buffer.prototype, "parent", {
            enumerable: true,
            get: function() {
              if (!Buffer.isBuffer(this)) return undefined;
              return this.buffer;
            }
          });

          Object.defineProperty(Buffer.prototype, "offset", {
            enumerable: true,
            get: function() {
              if (!Buffer.isBuffer(this)) return undefined;
              return this.byteOffset;
            }
          });

          function createBuffer(length) {
            if (length > K_MAX_LENGTH) {
              throw new RangeError(
                'The value "' + length + '" is invalid for option "size"'
              );
            }
            // Return an augmented `Uint8Array` instance
            var buf = new Uint8Array(length);
            buf.__proto__ = Buffer.prototype;
            return buf;
          }

          /**
           * The Buffer constructor returns instances of `Uint8Array` that have their
           * prototype changed to `Buffer.prototype`. Furthermore, `Buffer` is a subclass of
           * `Uint8Array`, so the returned instances will have all the node `Buffer` methods
           * and the `Uint8Array` methods. Square bracket notation works as expected -- it
           * returns a single octet.
           *
           * The `Uint8Array` prototype remains unmodified.
           */

          function Buffer(arg, encodingOrOffset, length) {
            // Common case.
            if (typeof arg === "number") {
              if (typeof encodingOrOffset === "string") {
                throw new TypeError(
                  'The "string" argument must be of type string. Received type number'
                );
              }
              return allocUnsafe(arg);
            }
            return from(arg, encodingOrOffset, length);
          }

          // Fix subarray() in ES2016. See: https://github.com/feross/buffer/pull/97
          if (
            typeof Symbol !== "undefined" &&
            Symbol.species != null &&
            Buffer[Symbol.species] === Buffer
          ) {
            Object.defineProperty(Buffer, Symbol.species, {
              value: null,
              configurable: true,
              enumerable: false,
              writable: false
            });
          }

          Buffer.poolSize = 8192; // not used by this implementation

          function from(value, encodingOrOffset, length) {
            if (typeof value === "string") {
              return fromString(value, encodingOrOffset);
            }

            if (ArrayBuffer.isView(value)) {
              return fromArrayLike(value);
            }

            if (value == null) {
              throw TypeError(
                "The first argument must be one of type string, Buffer, ArrayBuffer, Array, " +
                  "or Array-like Object. Received type " +
                  typeof value
              );
            }

            if (
              isInstance(value, ArrayBuffer) ||
              (value && isInstance(value.buffer, ArrayBuffer))
            ) {
              return fromArrayBuffer(value, encodingOrOffset, length);
            }

            if (typeof value === "number") {
              throw new TypeError(
                'The "value" argument must not be of type number. Received type number'
              );
            }

            var valueOf = value.valueOf && value.valueOf();
            if (valueOf != null && valueOf !== value) {
              return Buffer.from(valueOf, encodingOrOffset, length);
            }

            var b = fromObject(value);
            if (b) return b;

            if (
              typeof Symbol !== "undefined" &&
              Symbol.toPrimitive != null &&
              typeof value[Symbol.toPrimitive] === "function"
            ) {
              return Buffer.from(
                value[Symbol.toPrimitive]("string"),
                encodingOrOffset,
                length
              );
            }

            throw new TypeError(
              "The first argument must be one of type string, Buffer, ArrayBuffer, Array, " +
                "or Array-like Object. Received type " +
                typeof value
            );
          }

          /**
           * Functionally equivalent to Buffer(arg, encoding) but throws a TypeError
           * if value is a number.
           * Buffer.from(str[, encoding])
           * Buffer.from(array)
           * Buffer.from(buffer)
           * Buffer.from(arrayBuffer[, byteOffset[, length]])
           **/
          Buffer.from = function(value, encodingOrOffset, length) {
            return from(value, encodingOrOffset, length);
          };

          // Note: Change prototype *after* Buffer.from is defined to workaround Chrome bug:
          // https://github.com/feross/buffer/pull/148
          Buffer.prototype.__proto__ = Uint8Array.prototype;
          Buffer.__proto__ = Uint8Array;

          function assertSize(size) {
            if (typeof size !== "number") {
              throw new TypeError('"size" argument must be of type number');
            } else if (size < 0) {
              throw new RangeError(
                'The value "' + size + '" is invalid for option "size"'
              );
            }
          }

          function alloc(size, fill, encoding) {
            assertSize(size);
            if (size <= 0) {
              return createBuffer(size);
            }
            if (fill !== undefined) {
              // Only pay attention to encoding if it's a string. This
              // prevents accidentally sending in a number that would
              // be interpretted as a start offset.
              return typeof encoding === "string"
                ? createBuffer(size).fill(fill, encoding)
                : createBuffer(size).fill(fill);
            }
            return createBuffer(size);
          }

          /**
           * Creates a new filled Buffer instance.
           * alloc(size[, fill[, encoding]])
           **/
          Buffer.alloc = function(size, fill, encoding) {
            return alloc(size, fill, encoding);
          };

          function allocUnsafe(size) {
            assertSize(size);
            return createBuffer(size < 0 ? 0 : checked(size) | 0);
          }

          /**
           * Equivalent to Buffer(num), by default creates a non-zero-filled Buffer instance.
           * */
          Buffer.allocUnsafe = function(size) {
            return allocUnsafe(size);
          };
          /**
           * Equivalent to SlowBuffer(num), by default creates a non-zero-filled Buffer instance.
           */
          Buffer.allocUnsafeSlow = function(size) {
            return allocUnsafe(size);
          };

          function fromString(string, encoding) {
            if (typeof encoding !== "string" || encoding === "") {
              encoding = "utf8";
            }

            if (!Buffer.isEncoding(encoding)) {
              throw new TypeError("Unknown encoding: " + encoding);
            }

            var length = byteLength(string, encoding) | 0;
            var buf = createBuffer(length);

            var actual = buf.write(string, encoding);

            if (actual !== length) {
              // Writing a hex string, for example, that contains invalid characters will
              // cause everything after the first invalid character to be ignored. (e.g.
              // 'abxxcd' will be treated as 'ab')
              buf = buf.slice(0, actual);
            }

            return buf;
          }

          function fromArrayLike(array) {
            var length = array.length < 0 ? 0 : checked(array.length) | 0;
            var buf = createBuffer(length);
            for (var i = 0; i < length; i += 1) {
              buf[i] = array[i] & 255;
            }
            return buf;
          }

          function fromArrayBuffer(array, byteOffset, length) {
            if (byteOffset < 0 || array.byteLength < byteOffset) {
              throw new RangeError('"offset" is outside of buffer bounds');
            }

            if (array.byteLength < byteOffset + (length || 0)) {
              throw new RangeError('"length" is outside of buffer bounds');
            }

            var buf;
            if (byteOffset === undefined && length === undefined) {
              buf = new Uint8Array(array);
            } else if (length === undefined) {
              buf = new Uint8Array(array, byteOffset);
            } else {
              buf = new Uint8Array(array, byteOffset, length);
            }

            // Return an augmented `Uint8Array` instance
            buf.__proto__ = Buffer.prototype;
            return buf;
          }

          function fromObject(obj) {
            if (Buffer.isBuffer(obj)) {
              var len = checked(obj.length) | 0;
              var buf = createBuffer(len);

              if (buf.length === 0) {
                return buf;
              }

              obj.copy(buf, 0, 0, len);
              return buf;
            }

            if (obj.length !== undefined) {
              if (typeof obj.length !== "number" || numberIsNaN(obj.length)) {
                return createBuffer(0);
              }
              return fromArrayLike(obj);
            }

            if (obj.type === "Buffer" && Array.isArray(obj.data)) {
              return fromArrayLike(obj.data);
            }
          }

          function checked(length) {
            // Note: cannot use `length < K_MAX_LENGTH` here because that fails when
            // length is NaN (which is otherwise coerced to zero.)
            if (length >= K_MAX_LENGTH) {
              throw new RangeError(
                "Attempt to allocate Buffer larger than maximum " +
                  "size: 0x" +
                  K_MAX_LENGTH.toString(16) +
                  " bytes"
              );
            }
            return length | 0;
          }

          function SlowBuffer(length) {
            if (+length != length) {
              // eslint-disable-line eqeqeq
              length = 0;
            }
            return Buffer.alloc(+length);
          }

          Buffer.isBuffer = function isBuffer(b) {
            return b != null && b._isBuffer === true && b !== Buffer.prototype; // so Buffer.isBuffer(Buffer.prototype) will be false
          };

          Buffer.compare = function compare(a, b) {
            if (isInstance(a, Uint8Array))
              a = Buffer.from(a, a.offset, a.byteLength);
            if (isInstance(b, Uint8Array))
              b = Buffer.from(b, b.offset, b.byteLength);
            if (!Buffer.isBuffer(a) || !Buffer.isBuffer(b)) {
              throw new TypeError(
                'The "buf1", "buf2" arguments must be one of type Buffer or Uint8Array'
              );
            }

            if (a === b) return 0;

            var x = a.length;
            var y = b.length;

            for (var i = 0, len = Math.min(x, y); i < len; ++i) {
              if (a[i] !== b[i]) {
                x = a[i];
                y = b[i];
                break;
              }
            }

            if (x < y) return -1;
            if (y < x) return 1;
            return 0;
          };

          Buffer.isEncoding = function isEncoding(encoding) {
            switch (String(encoding).toLowerCase()) {
              case "hex":
              case "utf8":
              case "utf-8":
              case "ascii":
              case "latin1":
              case "binary":
              case "base64":
              case "ucs2":
              case "ucs-2":
              case "utf16le":
              case "utf-16le":
                return true;
              default:
                return false;
            }
          };

          Buffer.concat = function concat(list, length) {
            if (!Array.isArray(list)) {
              throw new TypeError(
                '"list" argument must be an Array of Buffers'
              );
            }

            if (list.length === 0) {
              return Buffer.alloc(0);
            }

            var i;
            if (length === undefined) {
              length = 0;
              for (i = 0; i < list.length; ++i) {
                length += list[i].length;
              }
            }

            var buffer = Buffer.allocUnsafe(length);
            var pos = 0;
            for (i = 0; i < list.length; ++i) {
              var buf = list[i];
              if (isInstance(buf, Uint8Array)) {
                buf = Buffer.from(buf);
              }
              if (!Buffer.isBuffer(buf)) {
                throw new TypeError(
                  '"list" argument must be an Array of Buffers'
                );
              }
              buf.copy(buffer, pos);
              pos += buf.length;
            }
            return buffer;
          };

          function byteLength(string, encoding) {
            if (Buffer.isBuffer(string)) {
              return string.length;
            }
            if (ArrayBuffer.isView(string) || isInstance(string, ArrayBuffer)) {
              return string.byteLength;
            }
            if (typeof string !== "string") {
              throw new TypeError(
                'The "string" argument must be one of type string, Buffer, or ArrayBuffer. ' +
                  "Received type " +
                  typeof string
              );
            }

            var len = string.length;
            var mustMatch = arguments.length > 2 && arguments[2] === true;
            if (!mustMatch && len === 0) return 0;

            // Use a for loop to avoid recursion
            var loweredCase = false;
            for (;;) {
              switch (encoding) {
                case "ascii":
                case "latin1":
                case "binary":
                  return len;
                case "utf8":
                case "utf-8":
                  return utf8ToBytes(string).length;
                case "ucs2":
                case "ucs-2":
                case "utf16le":
                case "utf-16le":
                  return len * 2;
                case "hex":
                  return len >>> 1;
                case "base64":
                  return base64ToBytes(string).length;
                default:
                  if (loweredCase) {
                    return mustMatch ? -1 : utf8ToBytes(string).length; // assume utf8
                  }
                  encoding = ("" + encoding).toLowerCase();
                  loweredCase = true;
              }
            }
          }
          Buffer.byteLength = byteLength;

          function slowToString(encoding, start, end) {
            var loweredCase = false;

            // No need to verify that "this.length <= MAX_UINT32" since it's a read-only
            // property of a typed array.

            // This behaves neither like String nor Uint8Array in that we set start/end
            // to their upper/lower bounds if the value passed is out of range.
            // undefined is handled specially as per ECMA-262 6th Edition,
            // Section 13.3.3.7 Runtime Semantics: KeyedBindingInitialization.
            if (start === undefined || start < 0) {
              start = 0;
            }
            // Return early if start > this.length. Done here to prevent potential uint32
            // coercion fail below.
            if (start > this.length) {
              return "";
            }

            if (end === undefined || end > this.length) {
              end = this.length;
            }

            if (end <= 0) {
              return "";
            }

            // Force coersion to uint32. This will also coerce falsey/NaN values to 0.
            end >>>= 0;
            start >>>= 0;

            if (end <= start) {
              return "";
            }

            if (!encoding) encoding = "utf8";

            while (true) {
              switch (encoding) {
                case "hex":
                  return hexSlice(this, start, end);

                case "utf8":
                case "utf-8":
                  return utf8Slice(this, start, end);

                case "ascii":
                  return asciiSlice(this, start, end);

                case "latin1":
                case "binary":
                  return latin1Slice(this, start, end);

                case "base64":
                  return base64Slice(this, start, end);

                case "ucs2":
                case "ucs-2":
                case "utf16le":
                case "utf-16le":
                  return utf16leSlice(this, start, end);

                default:
                  if (loweredCase)
                    throw new TypeError("Unknown encoding: " + encoding);
                  encoding = (encoding + "").toLowerCase();
                  loweredCase = true;
              }
            }
          }

          // This property is used by `Buffer.isBuffer` (and the `is-buffer` npm package)
          // to detect a Buffer instance. It's not possible to use `instanceof Buffer`
          // reliably in a browserify context because there could be multiple different
          // copies of the 'buffer' package in use. This method works even for Buffer
          // instances that were created from another copy of the `buffer` package.
          // See: https://github.com/feross/buffer/issues/154
          Buffer.prototype._isBuffer = true;

          function swap(b, n, m) {
            var i = b[n];
            b[n] = b[m];
            b[m] = i;
          }

          Buffer.prototype.swap16 = function swap16() {
            var len = this.length;
            if (len % 2 !== 0) {
              throw new RangeError("Buffer size must be a multiple of 16-bits");
            }
            for (var i = 0; i < len; i += 2) {
              swap(this, i, i + 1);
            }
            return this;
          };

          Buffer.prototype.swap32 = function swap32() {
            var len = this.length;
            if (len % 4 !== 0) {
              throw new RangeError("Buffer size must be a multiple of 32-bits");
            }
            for (var i = 0; i < len; i += 4) {
              swap(this, i, i + 3);
              swap(this, i + 1, i + 2);
            }
            return this;
          };

          Buffer.prototype.swap64 = function swap64() {
            var len = this.length;
            if (len % 8 !== 0) {
              throw new RangeError("Buffer size must be a multiple of 64-bits");
            }
            for (var i = 0; i < len; i += 8) {
              swap(this, i, i + 7);
              swap(this, i + 1, i + 6);
              swap(this, i + 2, i + 5);
              swap(this, i + 3, i + 4);
            }
            return this;
          };

          Buffer.prototype.toString = function toString() {
            var length = this.length;
            if (length === 0) return "";
            if (arguments.length === 0) return utf8Slice(this, 0, length);
            return slowToString.apply(this, arguments);
          };

          Buffer.prototype.toLocaleString = Buffer.prototype.toString;

          Buffer.prototype.equals = function equals(b) {
            if (!Buffer.isBuffer(b))
              throw new TypeError("Argument must be a Buffer");
            if (this === b) return true;
            return Buffer.compare(this, b) === 0;
          };

          Buffer.prototype.inspect = function inspect() {
            var str = "";
            var max = exports.INSPECT_MAX_BYTES;
            str = this.toString("hex", 0, max)
              .replace(/(.{2})/g, "$1 ")
              .trim();
            if (this.length > max) str += " ... ";
            return "<Buffer " + str + ">";
          };

          Buffer.prototype.compare = function compare(
            target,
            start,
            end,
            thisStart,
            thisEnd
          ) {
            if (isInstance(target, Uint8Array)) {
              target = Buffer.from(target, target.offset, target.byteLength);
            }
            if (!Buffer.isBuffer(target)) {
              throw new TypeError(
                'The "target" argument must be one of type Buffer or Uint8Array. ' +
                  "Received type " +
                  typeof target
              );
            }

            if (start === undefined) {
              start = 0;
            }
            if (end === undefined) {
              end = target ? target.length : 0;
            }
            if (thisStart === undefined) {
              thisStart = 0;
            }
            if (thisEnd === undefined) {
              thisEnd = this.length;
            }

            if (
              start < 0 ||
              end > target.length ||
              thisStart < 0 ||
              thisEnd > this.length
            ) {
              throw new RangeError("out of range index");
            }

            if (thisStart >= thisEnd && start >= end) {
              return 0;
            }
            if (thisStart >= thisEnd) {
              return -1;
            }
            if (start >= end) {
              return 1;
            }

            start >>>= 0;
            end >>>= 0;
            thisStart >>>= 0;
            thisEnd >>>= 0;

            if (this === target) return 0;

            var x = thisEnd - thisStart;
            var y = end - start;
            var len = Math.min(x, y);

            var thisCopy = this.slice(thisStart, thisEnd);
            var targetCopy = target.slice(start, end);

            for (var i = 0; i < len; ++i) {
              if (thisCopy[i] !== targetCopy[i]) {
                x = thisCopy[i];
                y = targetCopy[i];
                break;
              }
            }

            if (x < y) return -1;
            if (y < x) return 1;
            return 0;
          };

          // Finds either the first index of `val` in `buffer` at offset >= `byteOffset`,
          // OR the last index of `val` in `buffer` at offset <= `byteOffset`.
          //
          // Arguments:
          // - buffer - a Buffer to search
          // - val - a string, Buffer, or number
          // - byteOffset - an index into `buffer`; will be clamped to an int32
          // - encoding - an optional encoding, relevant is val is a string
          // - dir - true for indexOf, false for lastIndexOf
          function bidirectionalIndexOf(
            buffer,
            val,
            byteOffset,
            encoding,
            dir
          ) {
            // Empty buffer means no match
            if (buffer.length === 0) return -1;

            // Normalize byteOffset
            if (typeof byteOffset === "string") {
              encoding = byteOffset;
              byteOffset = 0;
            } else if (byteOffset > 0x7fffffff) {
              byteOffset = 0x7fffffff;
            } else if (byteOffset < -0x80000000) {
              byteOffset = -0x80000000;
            }
            byteOffset = +byteOffset; // Coerce to Number.
            if (numberIsNaN(byteOffset)) {
              // byteOffset: it it's undefined, null, NaN, "foo", etc, search whole buffer
              byteOffset = dir ? 0 : buffer.length - 1;
            }

            // Normalize byteOffset: negative offsets start from the end of the buffer
            if (byteOffset < 0) byteOffset = buffer.length + byteOffset;
            if (byteOffset >= buffer.length) {
              if (dir) return -1;
              else byteOffset = buffer.length - 1;
            } else if (byteOffset < 0) {
              if (dir) byteOffset = 0;
              else return -1;
            }

            // Normalize val
            if (typeof val === "string") {
              val = Buffer.from(val, encoding);
            }

            // Finally, search either indexOf (if dir is true) or lastIndexOf
            if (Buffer.isBuffer(val)) {
              // Special case: looking for empty string/buffer always fails
              if (val.length === 0) {
                return -1;
              }
              return arrayIndexOf(buffer, val, byteOffset, encoding, dir);
            } else if (typeof val === "number") {
              val = val & 0xff; // Search for a byte value [0-255]
              if (typeof Uint8Array.prototype.indexOf === "function") {
                if (dir) {
                  return Uint8Array.prototype.indexOf.call(
                    buffer,
                    val,
                    byteOffset
                  );
                } else {
                  return Uint8Array.prototype.lastIndexOf.call(
                    buffer,
                    val,
                    byteOffset
                  );
                }
              }
              return arrayIndexOf(buffer, [val], byteOffset, encoding, dir);
            }

            throw new TypeError("val must be string, number or Buffer");
          }

          function arrayIndexOf(arr, val, byteOffset, encoding, dir) {
            var indexSize = 1;
            var arrLength = arr.length;
            var valLength = val.length;

            if (encoding !== undefined) {
              encoding = String(encoding).toLowerCase();
              if (
                encoding === "ucs2" ||
                encoding === "ucs-2" ||
                encoding === "utf16le" ||
                encoding === "utf-16le"
              ) {
                if (arr.length < 2 || val.length < 2) {
                  return -1;
                }
                indexSize = 2;
                arrLength /= 2;
                valLength /= 2;
                byteOffset /= 2;
              }
            }

            function read(buf, i) {
              if (indexSize === 1) {
                return buf[i];
              } else {
                return buf.readUInt16BE(i * indexSize);
              }
            }

            var i;
            if (dir) {
              var foundIndex = -1;
              for (i = byteOffset; i < arrLength; i++) {
                if (
                  read(arr, i) ===
                  read(val, foundIndex === -1 ? 0 : i - foundIndex)
                ) {
                  if (foundIndex === -1) foundIndex = i;
                  if (i - foundIndex + 1 === valLength)
                    return foundIndex * indexSize;
                } else {
                  if (foundIndex !== -1) i -= i - foundIndex;
                  foundIndex = -1;
                }
              }
            } else {
              if (byteOffset + valLength > arrLength)
                byteOffset = arrLength - valLength;
              for (i = byteOffset; i >= 0; i--) {
                var found = true;
                for (var j = 0; j < valLength; j++) {
                  if (read(arr, i + j) !== read(val, j)) {
                    found = false;
                    break;
                  }
                }
                if (found) return i;
              }
            }

            return -1;
          }

          Buffer.prototype.includes = function includes(
            val,
            byteOffset,
            encoding
          ) {
            return this.indexOf(val, byteOffset, encoding) !== -1;
          };

          Buffer.prototype.indexOf = function indexOf(
            val,
            byteOffset,
            encoding
          ) {
            return bidirectionalIndexOf(this, val, byteOffset, encoding, true);
          };

          Buffer.prototype.lastIndexOf = function lastIndexOf(
            val,
            byteOffset,
            encoding
          ) {
            return bidirectionalIndexOf(this, val, byteOffset, encoding, false);
          };

          function hexWrite(buf, string, offset, length) {
            offset = Number(offset) || 0;
            var remaining = buf.length - offset;
            if (!length) {
              length = remaining;
            } else {
              length = Number(length);
              if (length > remaining) {
                length = remaining;
              }
            }

            var strLen = string.length;

            if (length > strLen / 2) {
              length = strLen / 2;
            }
            for (var i = 0; i < length; ++i) {
              var parsed = parseInt(string.substr(i * 2, 2), 16);
              if (numberIsNaN(parsed)) return i;
              buf[offset + i] = parsed;
            }
            return i;
          }

          function utf8Write(buf, string, offset, length) {
            return blitBuffer(
              utf8ToBytes(string, buf.length - offset),
              buf,
              offset,
              length
            );
          }

          function asciiWrite(buf, string, offset, length) {
            return blitBuffer(asciiToBytes(string), buf, offset, length);
          }

          function latin1Write(buf, string, offset, length) {
            return asciiWrite(buf, string, offset, length);
          }

          function base64Write(buf, string, offset, length) {
            return blitBuffer(base64ToBytes(string), buf, offset, length);
          }

          function ucs2Write(buf, string, offset, length) {
            return blitBuffer(
              utf16leToBytes(string, buf.length - offset),
              buf,
              offset,
              length
            );
          }

          Buffer.prototype.write = function write(
            string,
            offset,
            length,
            encoding
          ) {
            // Buffer#write(string)
            if (offset === undefined) {
              encoding = "utf8";
              length = this.length;
              offset = 0;
              // Buffer#write(string, encoding)
            } else if (length === undefined && typeof offset === "string") {
              encoding = offset;
              length = this.length;
              offset = 0;
              // Buffer#write(string, offset[, length][, encoding])
            } else if (isFinite(offset)) {
              offset = offset >>> 0;
              if (isFinite(length)) {
                length = length >>> 0;
                if (encoding === undefined) encoding = "utf8";
              } else {
                encoding = length;
                length = undefined;
              }
            } else {
              throw new Error(
                "Buffer.write(string, encoding, offset[, length]) is no longer supported"
              );
            }

            var remaining = this.length - offset;
            if (length === undefined || length > remaining) length = remaining;

            if (
              (string.length > 0 && (length < 0 || offset < 0)) ||
              offset > this.length
            ) {
              throw new RangeError("Attempt to write outside buffer bounds");
            }

            if (!encoding) encoding = "utf8";

            var loweredCase = false;
            for (;;) {
              switch (encoding) {
                case "hex":
                  return hexWrite(this, string, offset, length);

                case "utf8":
                case "utf-8":
                  return utf8Write(this, string, offset, length);

                case "ascii":
                  return asciiWrite(this, string, offset, length);

                case "latin1":
                case "binary":
                  return latin1Write(this, string, offset, length);

                case "base64":
                  // Warning: maxLength not taken into account in base64Write
                  return base64Write(this, string, offset, length);

                case "ucs2":
                case "ucs-2":
                case "utf16le":
                case "utf-16le":
                  return ucs2Write(this, string, offset, length);

                default:
                  if (loweredCase)
                    throw new TypeError("Unknown encoding: " + encoding);
                  encoding = ("" + encoding).toLowerCase();
                  loweredCase = true;
              }
            }
          };

          Buffer.prototype.toJSON = function toJSON() {
            return {
              type: "Buffer",
              data: Array.prototype.slice.call(this._arr || this, 0)
            };
          };

          function base64Slice(buf, start, end) {
            if (start === 0 && end === buf.length) {
              return base64.fromByteArray(buf);
            } else {
              return base64.fromByteArray(buf.slice(start, end));
            }
          }

          function utf8Slice(buf, start, end) {
            end = Math.min(buf.length, end);
            var res = [];

            var i = start;
            while (i < end) {
              var firstByte = buf[i];
              var codePoint = null;
              var bytesPerSequence =
                firstByte > 0xef
                  ? 4
                  : firstByte > 0xdf
                  ? 3
                  : firstByte > 0xbf
                  ? 2
                  : 1;

              if (i + bytesPerSequence <= end) {
                var secondByte, thirdByte, fourthByte, tempCodePoint;

                switch (bytesPerSequence) {
                  case 1:
                    if (firstByte < 0x80) {
                      codePoint = firstByte;
                    }
                    break;
                  case 2:
                    secondByte = buf[i + 1];
                    if ((secondByte & 0xc0) === 0x80) {
                      tempCodePoint =
                        ((firstByte & 0x1f) << 0x6) | (secondByte & 0x3f);
                      if (tempCodePoint > 0x7f) {
                        codePoint = tempCodePoint;
                      }
                    }
                    break;
                  case 3:
                    secondByte = buf[i + 1];
                    thirdByte = buf[i + 2];
                    if (
                      (secondByte & 0xc0) === 0x80 &&
                      (thirdByte & 0xc0) === 0x80
                    ) {
                      tempCodePoint =
                        ((firstByte & 0xf) << 0xc) |
                        ((secondByte & 0x3f) << 0x6) |
                        (thirdByte & 0x3f);
                      if (
                        tempCodePoint > 0x7ff &&
                        (tempCodePoint < 0xd800 || tempCodePoint > 0xdfff)
                      ) {
                        codePoint = tempCodePoint;
                      }
                    }
                    break;
                  case 4:
                    secondByte = buf[i + 1];
                    thirdByte = buf[i + 2];
                    fourthByte = buf[i + 3];
                    if (
                      (secondByte & 0xc0) === 0x80 &&
                      (thirdByte & 0xc0) === 0x80 &&
                      (fourthByte & 0xc0) === 0x80
                    ) {
                      tempCodePoint =
                        ((firstByte & 0xf) << 0x12) |
                        ((secondByte & 0x3f) << 0xc) |
                        ((thirdByte & 0x3f) << 0x6) |
                        (fourthByte & 0x3f);
                      if (tempCodePoint > 0xffff && tempCodePoint < 0x110000) {
                        codePoint = tempCodePoint;
                      }
                    }
                }
              }

              if (codePoint === null) {
                // we did not generate a valid codePoint so insert a
                // replacement char (U+FFFD) and advance only 1 byte
                codePoint = 0xfffd;
                bytesPerSequence = 1;
              } else if (codePoint > 0xffff) {
                // encode to utf16 (surrogate pair dance)
                codePoint -= 0x10000;
                res.push(((codePoint >>> 10) & 0x3ff) | 0xd800);
                codePoint = 0xdc00 | (codePoint & 0x3ff);
              }

              res.push(codePoint);
              i += bytesPerSequence;
            }

            return decodeCodePointsArray(res);
          }

          // Based on http://stackoverflow.com/a/22747272/680742, the browser with
          // the lowest limit is Chrome, with 0x10000 args.
          // We go 1 magnitude less, for safety
          var MAX_ARGUMENTS_LENGTH = 0x1000;

          function decodeCodePointsArray(codePoints) {
            var len = codePoints.length;
            if (len <= MAX_ARGUMENTS_LENGTH) {
              return String.fromCharCode.apply(String, codePoints); // avoid extra slice()
            }

            // Decode in chunks to avoid "call stack size exceeded".
            var res = "";
            var i = 0;
            while (i < len) {
              res += String.fromCharCode.apply(
                String,
                codePoints.slice(i, (i += MAX_ARGUMENTS_LENGTH))
              );
            }
            return res;
          }

          function asciiSlice(buf, start, end) {
            var ret = "";
            end = Math.min(buf.length, end);

            for (var i = start; i < end; ++i) {
              ret += String.fromCharCode(buf[i] & 0x7f);
            }
            return ret;
          }

          function latin1Slice(buf, start, end) {
            var ret = "";
            end = Math.min(buf.length, end);

            for (var i = start; i < end; ++i) {
              ret += String.fromCharCode(buf[i]);
            }
            return ret;
          }

          function hexSlice(buf, start, end) {
            var len = buf.length;

            if (!start || start < 0) start = 0;
            if (!end || end < 0 || end > len) end = len;

            var out = "";
            for (var i = start; i < end; ++i) {
              out += toHex(buf[i]);
            }
            return out;
          }

          function utf16leSlice(buf, start, end) {
            var bytes = buf.slice(start, end);
            var res = "";
            for (var i = 0; i < bytes.length; i += 2) {
              res += String.fromCharCode(bytes[i] + bytes[i + 1] * 256);
            }
            return res;
          }

          Buffer.prototype.slice = function slice(start, end) {
            var len = this.length;
            start = ~~start;
            end = end === undefined ? len : ~~end;

            if (start < 0) {
              start += len;
              if (start < 0) start = 0;
            } else if (start > len) {
              start = len;
            }

            if (end < 0) {
              end += len;
              if (end < 0) end = 0;
            } else if (end > len) {
              end = len;
            }

            if (end < start) end = start;

            var newBuf = this.subarray(start, end);
            // Return an augmented `Uint8Array` instance
            newBuf.__proto__ = Buffer.prototype;
            return newBuf;
          };

          /*
           * Need to make sure that buffer isn't trying to write out of bounds.
           */
          function checkOffset(offset, ext, length) {
            if (offset % 1 !== 0 || offset < 0)
              throw new RangeError("offset is not uint");
            if (offset + ext > length)
              throw new RangeError("Trying to access beyond buffer length");
          }

          Buffer.prototype.readUIntLE = function readUIntLE(
            offset,
            byteLength,
            noAssert
          ) {
            offset = offset >>> 0;
            byteLength = byteLength >>> 0;
            if (!noAssert) checkOffset(offset, byteLength, this.length);

            var val = this[offset];
            var mul = 1;
            var i = 0;
            while (++i < byteLength && (mul *= 0x100)) {
              val += this[offset + i] * mul;
            }

            return val;
          };

          Buffer.prototype.readUIntBE = function readUIntBE(
            offset,
            byteLength,
            noAssert
          ) {
            offset = offset >>> 0;
            byteLength = byteLength >>> 0;
            if (!noAssert) {
              checkOffset(offset, byteLength, this.length);
            }

            var val = this[offset + --byteLength];
            var mul = 1;
            while (byteLength > 0 && (mul *= 0x100)) {
              val += this[offset + --byteLength] * mul;
            }

            return val;
          };

          Buffer.prototype.readUInt8 = function readUInt8(offset, noAssert) {
            offset = offset >>> 0;
            if (!noAssert) checkOffset(offset, 1, this.length);
            return this[offset];
          };

          Buffer.prototype.readUInt16LE = function readUInt16LE(
            offset,
            noAssert
          ) {
            offset = offset >>> 0;
            if (!noAssert) checkOffset(offset, 2, this.length);
            return this[offset] | (this[offset + 1] << 8);
          };

          Buffer.prototype.readUInt16BE = function readUInt16BE(
            offset,
            noAssert
          ) {
            offset = offset >>> 0;
            if (!noAssert) checkOffset(offset, 2, this.length);
            return (this[offset] << 8) | this[offset + 1];
          };

          Buffer.prototype.readUInt32LE = function readUInt32LE(
            offset,
            noAssert
          ) {
            offset = offset >>> 0;
            if (!noAssert) checkOffset(offset, 4, this.length);

            return (
              (this[offset] |
                (this[offset + 1] << 8) |
                (this[offset + 2] << 16)) +
              this[offset + 3] * 0x1000000
            );
          };

          Buffer.prototype.readUInt32BE = function readUInt32BE(
            offset,
            noAssert
          ) {
            offset = offset >>> 0;
            if (!noAssert) checkOffset(offset, 4, this.length);

            return (
              this[offset] * 0x1000000 +
              ((this[offset + 1] << 16) |
                (this[offset + 2] << 8) |
                this[offset + 3])
            );
          };

          Buffer.prototype.readIntLE = function readIntLE(
            offset,
            byteLength,
            noAssert
          ) {
            offset = offset >>> 0;
            byteLength = byteLength >>> 0;
            if (!noAssert) checkOffset(offset, byteLength, this.length);

            var val = this[offset];
            var mul = 1;
            var i = 0;
            while (++i < byteLength && (mul *= 0x100)) {
              val += this[offset + i] * mul;
            }
            mul *= 0x80;

            if (val >= mul) val -= Math.pow(2, 8 * byteLength);

            return val;
          };

          Buffer.prototype.readIntBE = function readIntBE(
            offset,
            byteLength,
            noAssert
          ) {
            offset = offset >>> 0;
            byteLength = byteLength >>> 0;
            if (!noAssert) checkOffset(offset, byteLength, this.length);

            var i = byteLength;
            var mul = 1;
            var val = this[offset + --i];
            while (i > 0 && (mul *= 0x100)) {
              val += this[offset + --i] * mul;
            }
            mul *= 0x80;

            if (val >= mul) val -= Math.pow(2, 8 * byteLength);

            return val;
          };

          Buffer.prototype.readInt8 = function readInt8(offset, noAssert) {
            offset = offset >>> 0;
            if (!noAssert) checkOffset(offset, 1, this.length);
            if (!(this[offset] & 0x80)) return this[offset];
            return (0xff - this[offset] + 1) * -1;
          };

          Buffer.prototype.readInt16LE = function readInt16LE(
            offset,
            noAssert
          ) {
            offset = offset >>> 0;
            if (!noAssert) checkOffset(offset, 2, this.length);
            var val = this[offset] | (this[offset + 1] << 8);
            return val & 0x8000 ? val | 0xffff0000 : val;
          };

          Buffer.prototype.readInt16BE = function readInt16BE(
            offset,
            noAssert
          ) {
            offset = offset >>> 0;
            if (!noAssert) checkOffset(offset, 2, this.length);
            var val = this[offset + 1] | (this[offset] << 8);
            return val & 0x8000 ? val | 0xffff0000 : val;
          };

          Buffer.prototype.readInt32LE = function readInt32LE(
            offset,
            noAssert
          ) {
            offset = offset >>> 0;
            if (!noAssert) checkOffset(offset, 4, this.length);

            return (
              this[offset] |
              (this[offset + 1] << 8) |
              (this[offset + 2] << 16) |
              (this[offset + 3] << 24)
            );
          };

          Buffer.prototype.readInt32BE = function readInt32BE(
            offset,
            noAssert
          ) {
            offset = offset >>> 0;
            if (!noAssert) checkOffset(offset, 4, this.length);

            return (
              (this[offset] << 24) |
              (this[offset + 1] << 16) |
              (this[offset + 2] << 8) |
              this[offset + 3]
            );
          };

          Buffer.prototype.readFloatLE = function readFloatLE(
            offset,
            noAssert
          ) {
            offset = offset >>> 0;
            if (!noAssert) checkOffset(offset, 4, this.length);
            return ieee754.read(this, offset, true, 23, 4);
          };

          Buffer.prototype.readFloatBE = function readFloatBE(
            offset,
            noAssert
          ) {
            offset = offset >>> 0;
            if (!noAssert) checkOffset(offset, 4, this.length);
            return ieee754.read(this, offset, false, 23, 4);
          };

          Buffer.prototype.readDoubleLE = function readDoubleLE(
            offset,
            noAssert
          ) {
            offset = offset >>> 0;
            if (!noAssert) checkOffset(offset, 8, this.length);
            return ieee754.read(this, offset, true, 52, 8);
          };

          Buffer.prototype.readDoubleBE = function readDoubleBE(
            offset,
            noAssert
          ) {
            offset = offset >>> 0;
            if (!noAssert) checkOffset(offset, 8, this.length);
            return ieee754.read(this, offset, false, 52, 8);
          };

          function checkInt(buf, value, offset, ext, max, min) {
            if (!Buffer.isBuffer(buf))
              throw new TypeError(
                '"buffer" argument must be a Buffer instance'
              );
            if (value > max || value < min)
              throw new RangeError('"value" argument is out of bounds');
            if (offset + ext > buf.length)
              throw new RangeError("Index out of range");
          }

          Buffer.prototype.writeUIntLE = function writeUIntLE(
            value,
            offset,
            byteLength,
            noAssert
          ) {
            value = +value;
            offset = offset >>> 0;
            byteLength = byteLength >>> 0;
            if (!noAssert) {
              var maxBytes = Math.pow(2, 8 * byteLength) - 1;
              checkInt(this, value, offset, byteLength, maxBytes, 0);
            }

            var mul = 1;
            var i = 0;
            this[offset] = value & 0xff;
            while (++i < byteLength && (mul *= 0x100)) {
              this[offset + i] = (value / mul) & 0xff;
            }

            return offset + byteLength;
          };

          Buffer.prototype.writeUIntBE = function writeUIntBE(
            value,
            offset,
            byteLength,
            noAssert
          ) {
            value = +value;
            offset = offset >>> 0;
            byteLength = byteLength >>> 0;
            if (!noAssert) {
              var maxBytes = Math.pow(2, 8 * byteLength) - 1;
              checkInt(this, value, offset, byteLength, maxBytes, 0);
            }

            var i = byteLength - 1;
            var mul = 1;
            this[offset + i] = value & 0xff;
            while (--i >= 0 && (mul *= 0x100)) {
              this[offset + i] = (value / mul) & 0xff;
            }

            return offset + byteLength;
          };

          Buffer.prototype.writeUInt8 = function writeUInt8(
            value,
            offset,
            noAssert
          ) {
            value = +value;
            offset = offset >>> 0;
            if (!noAssert) checkInt(this, value, offset, 1, 0xff, 0);
            this[offset] = value & 0xff;
            return offset + 1;
          };

          Buffer.prototype.writeUInt16LE = function writeUInt16LE(
            value,
            offset,
            noAssert
          ) {
            value = +value;
            offset = offset >>> 0;
            if (!noAssert) checkInt(this, value, offset, 2, 0xffff, 0);
            this[offset] = value & 0xff;
            this[offset + 1] = value >>> 8;
            return offset + 2;
          };

          Buffer.prototype.writeUInt16BE = function writeUInt16BE(
            value,
            offset,
            noAssert
          ) {
            value = +value;
            offset = offset >>> 0;
            if (!noAssert) checkInt(this, value, offset, 2, 0xffff, 0);
            this[offset] = value >>> 8;
            this[offset + 1] = value & 0xff;
            return offset + 2;
          };

          Buffer.prototype.writeUInt32LE = function writeUInt32LE(
            value,
            offset,
            noAssert
          ) {
            value = +value;
            offset = offset >>> 0;
            if (!noAssert) checkInt(this, value, offset, 4, 0xffffffff, 0);
            this[offset + 3] = value >>> 24;
            this[offset + 2] = value >>> 16;
            this[offset + 1] = value >>> 8;
            this[offset] = value & 0xff;
            return offset + 4;
          };

          Buffer.prototype.writeUInt32BE = function writeUInt32BE(
            value,
            offset,
            noAssert
          ) {
            value = +value;
            offset = offset >>> 0;
            if (!noAssert) checkInt(this, value, offset, 4, 0xffffffff, 0);
            this[offset] = value >>> 24;
            this[offset + 1] = value >>> 16;
            this[offset + 2] = value >>> 8;
            this[offset + 3] = value & 0xff;
            return offset + 4;
          };

          Buffer.prototype.writeIntLE = function writeIntLE(
            value,
            offset,
            byteLength,
            noAssert
          ) {
            value = +value;
            offset = offset >>> 0;
            if (!noAssert) {
              var limit = Math.pow(2, 8 * byteLength - 1);

              checkInt(this, value, offset, byteLength, limit - 1, -limit);
            }

            var i = 0;
            var mul = 1;
            var sub = 0;
            this[offset] = value & 0xff;
            while (++i < byteLength && (mul *= 0x100)) {
              if (value < 0 && sub === 0 && this[offset + i - 1] !== 0) {
                sub = 1;
              }
              this[offset + i] = (((value / mul) >> 0) - sub) & 0xff;
            }

            return offset + byteLength;
          };

          Buffer.prototype.writeIntBE = function writeIntBE(
            value,
            offset,
            byteLength,
            noAssert
          ) {
            value = +value;
            offset = offset >>> 0;
            if (!noAssert) {
              var limit = Math.pow(2, 8 * byteLength - 1);

              checkInt(this, value, offset, byteLength, limit - 1, -limit);
            }

            var i = byteLength - 1;
            var mul = 1;
            var sub = 0;
            this[offset + i] = value & 0xff;
            while (--i >= 0 && (mul *= 0x100)) {
              if (value < 0 && sub === 0 && this[offset + i + 1] !== 0) {
                sub = 1;
              }
              this[offset + i] = (((value / mul) >> 0) - sub) & 0xff;
            }

            return offset + byteLength;
          };

          Buffer.prototype.writeInt8 = function writeInt8(
            value,
            offset,
            noAssert
          ) {
            value = +value;
            offset = offset >>> 0;
            if (!noAssert) checkInt(this, value, offset, 1, 0x7f, -0x80);
            if (value < 0) value = 0xff + value + 1;
            this[offset] = value & 0xff;
            return offset + 1;
          };

          Buffer.prototype.writeInt16LE = function writeInt16LE(
            value,
            offset,
            noAssert
          ) {
            value = +value;
            offset = offset >>> 0;
            if (!noAssert) checkInt(this, value, offset, 2, 0x7fff, -0x8000);
            this[offset] = value & 0xff;
            this[offset + 1] = value >>> 8;
            return offset + 2;
          };

          Buffer.prototype.writeInt16BE = function writeInt16BE(
            value,
            offset,
            noAssert
          ) {
            value = +value;
            offset = offset >>> 0;
            if (!noAssert) checkInt(this, value, offset, 2, 0x7fff, -0x8000);
            this[offset] = value >>> 8;
            this[offset + 1] = value & 0xff;
            return offset + 2;
          };

          Buffer.prototype.writeInt32LE = function writeInt32LE(
            value,
            offset,
            noAssert
          ) {
            value = +value;
            offset = offset >>> 0;
            if (!noAssert)
              checkInt(this, value, offset, 4, 0x7fffffff, -0x80000000);
            this[offset] = value & 0xff;
            this[offset + 1] = value >>> 8;
            this[offset + 2] = value >>> 16;
            this[offset + 3] = value >>> 24;
            return offset + 4;
          };

          Buffer.prototype.writeInt32BE = function writeInt32BE(
            value,
            offset,
            noAssert
          ) {
            value = +value;
            offset = offset >>> 0;
            if (!noAssert)
              checkInt(this, value, offset, 4, 0x7fffffff, -0x80000000);
            if (value < 0) value = 0xffffffff + value + 1;
            this[offset] = value >>> 24;
            this[offset + 1] = value >>> 16;
            this[offset + 2] = value >>> 8;
            this[offset + 3] = value & 0xff;
            return offset + 4;
          };

          function checkIEEE754(buf, value, offset, ext, max, min) {
            if (offset + ext > buf.length)
              throw new RangeError("Index out of range");
            if (offset < 0) throw new RangeError("Index out of range");
          }

          function writeFloat(buf, value, offset, littleEndian, noAssert) {
            value = +value;
            offset = offset >>> 0;
            if (!noAssert) {
              checkIEEE754(
                buf,
                value,
                offset,
                4,
                3.4028234663852886e38,
                -3.4028234663852886e38
              );
            }
            ieee754.write(buf, value, offset, littleEndian, 23, 4);
            return offset + 4;
          }

          Buffer.prototype.writeFloatLE = function writeFloatLE(
            value,
            offset,
            noAssert
          ) {
            return writeFloat(this, value, offset, true, noAssert);
          };

          Buffer.prototype.writeFloatBE = function writeFloatBE(
            value,
            offset,
            noAssert
          ) {
            return writeFloat(this, value, offset, false, noAssert);
          };

          function writeDouble(buf, value, offset, littleEndian, noAssert) {
            value = +value;
            offset = offset >>> 0;
            if (!noAssert) {
              checkIEEE754(
                buf,
                value,
                offset,
                8,
                1.7976931348623157e308,
                -1.7976931348623157e308
              );
            }
            ieee754.write(buf, value, offset, littleEndian, 52, 8);
            return offset + 8;
          }

          Buffer.prototype.writeDoubleLE = function writeDoubleLE(
            value,
            offset,
            noAssert
          ) {
            return writeDouble(this, value, offset, true, noAssert);
          };

          Buffer.prototype.writeDoubleBE = function writeDoubleBE(
            value,
            offset,
            noAssert
          ) {
            return writeDouble(this, value, offset, false, noAssert);
          };

          // copy(targetBuffer, targetStart=0, sourceStart=0, sourceEnd=buffer.length)
          Buffer.prototype.copy = function copy(
            target,
            targetStart,
            start,
            end
          ) {
            if (!Buffer.isBuffer(target))
              throw new TypeError("argument should be a Buffer");
            if (!start) start = 0;
            if (!end && end !== 0) end = this.length;
            if (targetStart >= target.length) targetStart = target.length;
            if (!targetStart) targetStart = 0;
            if (end > 0 && end < start) end = start;

            // Copy 0 bytes; we're done
            if (end === start) return 0;
            if (target.length === 0 || this.length === 0) return 0;

            // Fatal error conditions
            if (targetStart < 0) {
              throw new RangeError("targetStart out of bounds");
            }
            if (start < 0 || start >= this.length)
              throw new RangeError("Index out of range");
            if (end < 0) throw new RangeError("sourceEnd out of bounds");

            // Are we oob?
            if (end > this.length) end = this.length;
            if (target.length - targetStart < end - start) {
              end = target.length - targetStart + start;
            }

            var len = end - start;

            if (
              this === target &&
              typeof Uint8Array.prototype.copyWithin === "function"
            ) {
              // Use built-in when available, missing from IE11
              this.copyWithin(targetStart, start, end);
            } else if (
              this === target &&
              start < targetStart &&
              targetStart < end
            ) {
              // descending copy from end
              for (var i = len - 1; i >= 0; --i) {
                target[i + targetStart] = this[i + start];
              }
            } else {
              Uint8Array.prototype.set.call(
                target,
                this.subarray(start, end),
                targetStart
              );
            }

            return len;
          };

          // Usage:
          //    buffer.fill(number[, offset[, end]])
          //    buffer.fill(buffer[, offset[, end]])
          //    buffer.fill(string[, offset[, end]][, encoding])
          Buffer.prototype.fill = function fill(val, start, end, encoding) {
            // Handle string cases:
            if (typeof val === "string") {
              if (typeof start === "string") {
                encoding = start;
                start = 0;
                end = this.length;
              } else if (typeof end === "string") {
                encoding = end;
                end = this.length;
              }
              if (encoding !== undefined && typeof encoding !== "string") {
                throw new TypeError("encoding must be a string");
              }
              if (
                typeof encoding === "string" &&
                !Buffer.isEncoding(encoding)
              ) {
                throw new TypeError("Unknown encoding: " + encoding);
              }
              if (val.length === 1) {
                var code = val.charCodeAt(0);
                if (
                  (encoding === "utf8" && code < 128) ||
                  encoding === "latin1"
                ) {
                  // Fast path: If `val` fits into a single byte, use that numeric value.
                  val = code;
                }
              }
            } else if (typeof val === "number") {
              val = val & 255;
            }

            // Invalid ranges are not set to a default, so can range check early.
            if (start < 0 || this.length < start || this.length < end) {
              throw new RangeError("Out of range index");
            }

            if (end <= start) {
              return this;
            }

            start = start >>> 0;
            end = end === undefined ? this.length : end >>> 0;

            if (!val) val = 0;

            var i;
            if (typeof val === "number") {
              for (i = start; i < end; ++i) {
                this[i] = val;
              }
            } else {
              var bytes = Buffer.isBuffer(val)
                ? val
                : Buffer.from(val, encoding);
              var len = bytes.length;
              if (len === 0) {
                throw new TypeError(
                  'The value "' + val + '" is invalid for argument "value"'
                );
              }
              for (i = 0; i < end - start; ++i) {
                this[i + start] = bytes[i % len];
              }
            }

            return this;
          };

          // HELPER FUNCTIONS
          // ================

          var INVALID_BASE64_RE = /[^+/0-9A-Za-z-_]/g;

          function base64clean(str) {
            // Node takes equal signs as end of the Base64 encoding
            str = str.split("=")[0];
            // Node strips out invalid characters like \n and \t from the string, base64-js does not
            str = str.trim().replace(INVALID_BASE64_RE, "");
            // Node converts strings with length < 2 to ''
            if (str.length < 2) return "";
            // Node allows for non-padded base64 strings (missing trailing ===), base64-js does not
            while (str.length % 4 !== 0) {
              str = str + "=";
            }
            return str;
          }

          function toHex(n) {
            if (n < 16) return "0" + n.toString(16);
            return n.toString(16);
          }

          function utf8ToBytes(string, units) {
            units = units || Infinity;
            var codePoint;
            var length = string.length;
            var leadSurrogate = null;
            var bytes = [];

            for (var i = 0; i < length; ++i) {
              codePoint = string.charCodeAt(i);

              // is surrogate component
              if (codePoint > 0xd7ff && codePoint < 0xe000) {
                // last char was a lead
                if (!leadSurrogate) {
                  // no lead yet
                  if (codePoint > 0xdbff) {
                    // unexpected trail
                    if ((units -= 3) > -1) bytes.push(0xef, 0xbf, 0xbd);
                    continue;
                  } else if (i + 1 === length) {
                    // unpaired lead
                    if ((units -= 3) > -1) bytes.push(0xef, 0xbf, 0xbd);
                    continue;
                  }

                  // valid lead
                  leadSurrogate = codePoint;

                  continue;
                }

                // 2 leads in a row
                if (codePoint < 0xdc00) {
                  if ((units -= 3) > -1) bytes.push(0xef, 0xbf, 0xbd);
                  leadSurrogate = codePoint;
                  continue;
                }

                // valid surrogate pair
                codePoint =
                  (((leadSurrogate - 0xd800) << 10) | (codePoint - 0xdc00)) +
                  0x10000;
              } else if (leadSurrogate) {
                // valid bmp char, but last char was a lead
                if ((units -= 3) > -1) bytes.push(0xef, 0xbf, 0xbd);
              }

              leadSurrogate = null;

              // encode utf8
              if (codePoint < 0x80) {
                if ((units -= 1) < 0) break;
                bytes.push(codePoint);
              } else if (codePoint < 0x800) {
                if ((units -= 2) < 0) break;
                bytes.push(
                  (codePoint >> 0x6) | 0xc0,
                  (codePoint & 0x3f) | 0x80
                );
              } else if (codePoint < 0x10000) {
                if ((units -= 3) < 0) break;
                bytes.push(
                  (codePoint >> 0xc) | 0xe0,
                  ((codePoint >> 0x6) & 0x3f) | 0x80,
                  (codePoint & 0x3f) | 0x80
                );
              } else if (codePoint < 0x110000) {
                if ((units -= 4) < 0) break;
                bytes.push(
                  (codePoint >> 0x12) | 0xf0,
                  ((codePoint >> 0xc) & 0x3f) | 0x80,
                  ((codePoint >> 0x6) & 0x3f) | 0x80,
                  (codePoint & 0x3f) | 0x80
                );
              } else {
                throw new Error("Invalid code point");
              }
            }

            return bytes;
          }

          function asciiToBytes(str) {
            var byteArray = [];
            for (var i = 0; i < str.length; ++i) {
              // Node's code seems to be doing this and not & 0x7F..
              byteArray.push(str.charCodeAt(i) & 0xff);
            }
            return byteArray;
          }

          function utf16leToBytes(str, units) {
            var c, hi, lo;
            var byteArray = [];
            for (var i = 0; i < str.length; ++i) {
              if ((units -= 2) < 0) break;

              c = str.charCodeAt(i);
              hi = c >> 8;
              lo = c % 256;
              byteArray.push(lo);
              byteArray.push(hi);
            }

            return byteArray;
          }

          function base64ToBytes(str) {
            return base64.toByteArray(base64clean(str));
          }

          function blitBuffer(src, dst, offset, length) {
            for (var i = 0; i < length; ++i) {
              if (i + offset >= dst.length || i >= src.length) break;
              dst[i + offset] = src[i];
            }
            return i;
          }

          // ArrayBuffer or Uint8Array objects from other contexts (i.e. iframes) do not pass
          // the `instanceof` check but they should be treated as of that type.
          // See: https://github.com/feross/buffer/issues/166
          function isInstance(obj, type) {
            return (
              obj instanceof type ||
              (obj != null &&
                obj.constructor != null &&
                obj.constructor.name != null &&
                obj.constructor.name === type.name)
            );
          }
          function numberIsNaN(obj) {
            // For IE11 support
            return obj !== obj; // eslint-disable-line no-self-compare
          }
        }.call(this, require("buffer").Buffer));
      },
      { "base64-js": 35, buffer: 36, ieee754: 38 }
    ],
    37: [
      function(require, module, exports) {
        // Copyright Joyent, Inc. and other Node contributors.
        //
        // Permission is hereby granted, free of charge, to any person obtaining a
        // copy of this software and associated documentation files (the
        // "Software"), to deal in the Software without restriction, including
        // without limitation the rights to use, copy, modify, merge, publish,
        // distribute, sublicense, and/or sell copies of the Software, and to permit
        // persons to whom the Software is furnished to do so, subject to the
        // following conditions:
        //
        // The above copyright notice and this permission notice shall be included
        // in all copies or substantial portions of the Software.
        //
        // THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS
        // OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
        // MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN
        // NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
        // DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
        // OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE
        // USE OR OTHER DEALINGS IN THE SOFTWARE.

        var objectCreate = Object.create || objectCreatePolyfill;
        var objectKeys = Object.keys || objectKeysPolyfill;
        var bind = Function.prototype.bind || functionBindPolyfill;

        function EventEmitter() {
          if (
            !this._events ||
            !Object.prototype.hasOwnProperty.call(this, "_events")
          ) {
            this._events = objectCreate(null);
            this._eventsCount = 0;
          }

          this._maxListeners = this._maxListeners || undefined;
        }
        module.exports = EventEmitter;

        // Backwards-compat with node 0.10.x
        EventEmitter.EventEmitter = EventEmitter;

        EventEmitter.prototype._events = undefined;
        EventEmitter.prototype._maxListeners = undefined;

        // By default EventEmitters will print a warning if more than 10 listeners are
        // added to it. This is a useful default which helps finding memory leaks.
        var defaultMaxListeners = 10;

        var hasDefineProperty;
        try {
          var o = {};
          if (Object.defineProperty)
            Object.defineProperty(o, "x", { value: 0 });
          hasDefineProperty = o.x === 0;
        } catch (err) {
          hasDefineProperty = false;
        }
        if (hasDefineProperty) {
          Object.defineProperty(EventEmitter, "defaultMaxListeners", {
            enumerable: true,
            get: function() {
              return defaultMaxListeners;
            },
            set: function(arg) {
              // check whether the input is a positive number (whose value is zero or
              // greater and not a NaN).
              if (typeof arg !== "number" || arg < 0 || arg !== arg)
                throw new TypeError(
                  '"defaultMaxListeners" must be a positive number'
                );
              defaultMaxListeners = arg;
            }
          });
        } else {
          EventEmitter.defaultMaxListeners = defaultMaxListeners;
        }

        // Obviously not all Emitters should be limited to 10. This function allows
        // that to be increased. Set to zero for unlimited.
        EventEmitter.prototype.setMaxListeners = function setMaxListeners(n) {
          if (typeof n !== "number" || n < 0 || isNaN(n))
            throw new TypeError('"n" argument must be a positive number');
          this._maxListeners = n;
          return this;
        };

        function $getMaxListeners(that) {
          if (that._maxListeners === undefined)
            return EventEmitter.defaultMaxListeners;
          return that._maxListeners;
        }

        EventEmitter.prototype.getMaxListeners = function getMaxListeners() {
          return $getMaxListeners(this);
        };

        // These standalone emit* functions are used to optimize calling of event
        // handlers for fast cases because emit() itself often has a variable number of
        // arguments and can be deoptimized because of that. These functions always have
        // the same number of arguments and thus do not get deoptimized, so the code
        // inside them can execute faster.
        function emitNone(handler, isFn, self) {
          if (isFn) handler.call(self);
          else {
            var len = handler.length;
            var listeners = arrayClone(handler, len);
            for (var i = 0; i < len; ++i) listeners[i].call(self);
          }
        }
        function emitOne(handler, isFn, self, arg1) {
          if (isFn) handler.call(self, arg1);
          else {
            var len = handler.length;
            var listeners = arrayClone(handler, len);
            for (var i = 0; i < len; ++i) listeners[i].call(self, arg1);
          }
        }
        function emitTwo(handler, isFn, self, arg1, arg2) {
          if (isFn) handler.call(self, arg1, arg2);
          else {
            var len = handler.length;
            var listeners = arrayClone(handler, len);
            for (var i = 0; i < len; ++i) listeners[i].call(self, arg1, arg2);
          }
        }
        function emitThree(handler, isFn, self, arg1, arg2, arg3) {
          if (isFn) handler.call(self, arg1, arg2, arg3);
          else {
            var len = handler.length;
            var listeners = arrayClone(handler, len);
            for (var i = 0; i < len; ++i)
              listeners[i].call(self, arg1, arg2, arg3);
          }
        }

        function emitMany(handler, isFn, self, args) {
          if (isFn) handler.apply(self, args);
          else {
            var len = handler.length;
            var listeners = arrayClone(handler, len);
            for (var i = 0; i < len; ++i) listeners[i].apply(self, args);
          }
        }

        EventEmitter.prototype.emit = function emit(type) {
          var er, handler, len, args, i, events;
          var doError = type === "error";

          events = this._events;
          if (events) doError = doError && events.error == null;
          else if (!doError) return false;

          // If there is no 'error' event listener then throw.
          if (doError) {
            if (arguments.length > 1) er = arguments[1];
            if (er instanceof Error) {
              throw er; // Unhandled 'error' event
            } else {
              // At least give some kind of context to the user
              var err = new Error('Unhandled "error" event. (' + er + ")");
              err.context = er;
              throw err;
            }
            return false;
          }

          handler = events[type];

          if (!handler) return false;

          var isFn = typeof handler === "function";
          len = arguments.length;
          switch (len) {
            // fast cases
            case 1:
              emitNone(handler, isFn, this);
              break;
            case 2:
              emitOne(handler, isFn, this, arguments[1]);
              break;
            case 3:
              emitTwo(handler, isFn, this, arguments[1], arguments[2]);
              break;
            case 4:
              emitThree(
                handler,
                isFn,
                this,
                arguments[1],
                arguments[2],
                arguments[3]
              );
              break;
            // slower
            default:
              args = new Array(len - 1);
              for (i = 1; i < len; i++) args[i - 1] = arguments[i];
              emitMany(handler, isFn, this, args);
          }

          return true;
        };

        function _addListener(target, type, listener, prepend) {
          var m;
          var events;
          var existing;

          if (typeof listener !== "function")
            throw new TypeError('"listener" argument must be a function');

          events = target._events;
          if (!events) {
            events = target._events = objectCreate(null);
            target._eventsCount = 0;
          } else {
            // To avoid recursion in the case that type === "newListener"! Before
            // adding it to the listeners, first emit "newListener".
            if (events.newListener) {
              target.emit(
                "newListener",
                type,
                listener.listener ? listener.listener : listener
              );

              // Re-assign `events` because a newListener handler could have caused the
              // this._events to be assigned to a new object
              events = target._events;
            }
            existing = events[type];
          }

          if (!existing) {
            // Optimize the case of one listener. Don't need the extra array object.
            existing = events[type] = listener;
            ++target._eventsCount;
          } else {
            if (typeof existing === "function") {
              // Adding the second element, need to change to array.
              existing = events[type] = prepend
                ? [listener, existing]
                : [existing, listener];
            } else {
              // If we've already got an array, just append.
              if (prepend) {
                existing.unshift(listener);
              } else {
                existing.push(listener);
              }
            }

            // Check for listener leak
            if (!existing.warned) {
              m = $getMaxListeners(target);
              if (m && m > 0 && existing.length > m) {
                existing.warned = true;
                var w = new Error(
                  "Possible EventEmitter memory leak detected. " +
                    existing.length +
                    ' "' +
                    String(type) +
                    '" listeners ' +
                    "added. Use emitter.setMaxListeners() to " +
                    "increase limit."
                );
                w.name = "MaxListenersExceededWarning";
                w.emitter = target;
                w.type = type;
                w.count = existing.length;
                if (typeof console === "object" && console.warn) {
                  console.warn("%s: %s", w.name, w.message);
                }
              }
            }
          }

          return target;
        }

        EventEmitter.prototype.addListener = function addListener(
          type,
          listener
        ) {
          return _addListener(this, type, listener, false);
        };

        EventEmitter.prototype.on = EventEmitter.prototype.addListener;

        EventEmitter.prototype.prependListener = function prependListener(
          type,
          listener
        ) {
          return _addListener(this, type, listener, true);
        };

        function onceWrapper() {
          if (!this.fired) {
            this.target.removeListener(this.type, this.wrapFn);
            this.fired = true;
            switch (arguments.length) {
              case 0:
                return this.listener.call(this.target);
              case 1:
                return this.listener.call(this.target, arguments[0]);
              case 2:
                return this.listener.call(
                  this.target,
                  arguments[0],
                  arguments[1]
                );
              case 3:
                return this.listener.call(
                  this.target,
                  arguments[0],
                  arguments[1],
                  arguments[2]
                );
              default:
                var args = new Array(arguments.length);
                for (var i = 0; i < args.length; ++i) args[i] = arguments[i];
                this.listener.apply(this.target, args);
            }
          }
        }

        function _onceWrap(target, type, listener) {
          var state = {
            fired: false,
            wrapFn: undefined,
            target: target,
            type: type,
            listener: listener
          };
          var wrapped = bind.call(onceWrapper, state);
          wrapped.listener = listener;
          state.wrapFn = wrapped;
          return wrapped;
        }

        EventEmitter.prototype.once = function once(type, listener) {
          if (typeof listener !== "function")
            throw new TypeError('"listener" argument must be a function');
          this.on(type, _onceWrap(this, type, listener));
          return this;
        };

        EventEmitter.prototype.prependOnceListener = function prependOnceListener(
          type,
          listener
        ) {
          if (typeof listener !== "function")
            throw new TypeError('"listener" argument must be a function');
          this.prependListener(type, _onceWrap(this, type, listener));
          return this;
        };

        // Emits a 'removeListener' event if and only if the listener was removed.
        EventEmitter.prototype.removeListener = function removeListener(
          type,
          listener
        ) {
          var list, events, position, i, originalListener;

          if (typeof listener !== "function")
            throw new TypeError('"listener" argument must be a function');

          events = this._events;
          if (!events) return this;

          list = events[type];
          if (!list) return this;

          if (list === listener || list.listener === listener) {
            if (--this._eventsCount === 0) this._events = objectCreate(null);
            else {
              delete events[type];
              if (events.removeListener)
                this.emit("removeListener", type, list.listener || listener);
            }
          } else if (typeof list !== "function") {
            position = -1;

            for (i = list.length - 1; i >= 0; i--) {
              if (list[i] === listener || list[i].listener === listener) {
                originalListener = list[i].listener;
                position = i;
                break;
              }
            }

            if (position < 0) return this;

            if (position === 0) list.shift();
            else spliceOne(list, position);

            if (list.length === 1) events[type] = list[0];

            if (events.removeListener)
              this.emit("removeListener", type, originalListener || listener);
          }

          return this;
        };

        EventEmitter.prototype.removeAllListeners = function removeAllListeners(
          type
        ) {
          var listeners, events, i;

          events = this._events;
          if (!events) return this;

          // not listening for removeListener, no need to emit
          if (!events.removeListener) {
            if (arguments.length === 0) {
              this._events = objectCreate(null);
              this._eventsCount = 0;
            } else if (events[type]) {
              if (--this._eventsCount === 0) this._events = objectCreate(null);
              else delete events[type];
            }
            return this;
          }

          // emit removeListener for all listeners on all events
          if (arguments.length === 0) {
            var keys = objectKeys(events);
            var key;
            for (i = 0; i < keys.length; ++i) {
              key = keys[i];
              if (key === "removeListener") continue;
              this.removeAllListeners(key);
            }
            this.removeAllListeners("removeListener");
            this._events = objectCreate(null);
            this._eventsCount = 0;
            return this;
          }

          listeners = events[type];

          if (typeof listeners === "function") {
            this.removeListener(type, listeners);
          } else if (listeners) {
            // LIFO order
            for (i = listeners.length - 1; i >= 0; i--) {
              this.removeListener(type, listeners[i]);
            }
          }

          return this;
        };

        function _listeners(target, type, unwrap) {
          var events = target._events;

          if (!events) return [];

          var evlistener = events[type];
          if (!evlistener) return [];

          if (typeof evlistener === "function")
            return unwrap ? [evlistener.listener || evlistener] : [evlistener];

          return unwrap
            ? unwrapListeners(evlistener)
            : arrayClone(evlistener, evlistener.length);
        }

        EventEmitter.prototype.listeners = function listeners(type) {
          return _listeners(this, type, true);
        };

        EventEmitter.prototype.rawListeners = function rawListeners(type) {
          return _listeners(this, type, false);
        };

        EventEmitter.listenerCount = function(emitter, type) {
          if (typeof emitter.listenerCount === "function") {
            return emitter.listenerCount(type);
          } else {
            return listenerCount.call(emitter, type);
          }
        };

        EventEmitter.prototype.listenerCount = listenerCount;
        function listenerCount(type) {
          var events = this._events;

          if (events) {
            var evlistener = events[type];

            if (typeof evlistener === "function") {
              return 1;
            } else if (evlistener) {
              return evlistener.length;
            }
          }

          return 0;
        }

        EventEmitter.prototype.eventNames = function eventNames() {
          return this._eventsCount > 0 ? Reflect.ownKeys(this._events) : [];
        };

        // About 1.5x faster than the two-arg version of Array#splice().
        function spliceOne(list, index) {
          for (var i = index, k = i + 1, n = list.length; k < n; i += 1, k += 1)
            list[i] = list[k];
          list.pop();
        }

        function arrayClone(arr, n) {
          var copy = new Array(n);
          for (var i = 0; i < n; ++i) copy[i] = arr[i];
          return copy;
        }

        function unwrapListeners(arr) {
          var ret = new Array(arr.length);
          for (var i = 0; i < ret.length; ++i) {
            ret[i] = arr[i].listener || arr[i];
          }
          return ret;
        }

        function objectCreatePolyfill(proto) {
          var F = function() {};
          F.prototype = proto;
          return new F();
        }
        function objectKeysPolyfill(obj) {
          var keys = [];
          for (var k in obj)
            if (Object.prototype.hasOwnProperty.call(obj, k)) {
              keys.push(k);
            }
          return k;
        }
        function functionBindPolyfill(context) {
          var fn = this;
          return function() {
            return fn.apply(context, arguments);
          };
        }
      },
      {}
    ],
    38: [
      function(require, module, exports) {
        exports.read = function(buffer, offset, isLE, mLen, nBytes) {
          var e, m;
          var eLen = nBytes * 8 - mLen - 1;
          var eMax = (1 << eLen) - 1;
          var eBias = eMax >> 1;
          var nBits = -7;
          var i = isLE ? nBytes - 1 : 0;
          var d = isLE ? -1 : 1;
          var s = buffer[offset + i];

          i += d;

          e = s & ((1 << -nBits) - 1);
          s >>= -nBits;
          nBits += eLen;
          for (
            ;
            nBits > 0;
            e = e * 256 + buffer[offset + i], i += d, nBits -= 8
          ) {}

          m = e & ((1 << -nBits) - 1);
          e >>= -nBits;
          nBits += mLen;
          for (
            ;
            nBits > 0;
            m = m * 256 + buffer[offset + i], i += d, nBits -= 8
          ) {}

          if (e === 0) {
            e = 1 - eBias;
          } else if (e === eMax) {
            return m ? NaN : (s ? -1 : 1) * Infinity;
          } else {
            m = m + Math.pow(2, mLen);
            e = e - eBias;
          }
          return (s ? -1 : 1) * m * Math.pow(2, e - mLen);
        };

        exports.write = function(buffer, value, offset, isLE, mLen, nBytes) {
          var e, m, c;
          var eLen = nBytes * 8 - mLen - 1;
          var eMax = (1 << eLen) - 1;
          var eBias = eMax >> 1;
          var rt = mLen === 23 ? Math.pow(2, -24) - Math.pow(2, -77) : 0;
          var i = isLE ? 0 : nBytes - 1;
          var d = isLE ? 1 : -1;
          var s = value < 0 || (value === 0 && 1 / value < 0) ? 1 : 0;

          value = Math.abs(value);

          if (isNaN(value) || value === Infinity) {
            m = isNaN(value) ? 1 : 0;
            e = eMax;
          } else {
            e = Math.floor(Math.log(value) / Math.LN2);
            if (value * (c = Math.pow(2, -e)) < 1) {
              e--;
              c *= 2;
            }
            if (e + eBias >= 1) {
              value += rt / c;
            } else {
              value += rt * Math.pow(2, 1 - eBias);
            }
            if (value * c >= 2) {
              e++;
              c /= 2;
            }

            if (e + eBias >= eMax) {
              m = 0;
              e = eMax;
            } else if (e + eBias >= 1) {
              m = (value * c - 1) * Math.pow(2, mLen);
              e = e + eBias;
            } else {
              m = value * Math.pow(2, eBias - 1) * Math.pow(2, mLen);
              e = 0;
            }
          }

          for (
            ;
            mLen >= 8;
            buffer[offset + i] = m & 0xff, i += d, m /= 256, mLen -= 8
          ) {}

          e = (e << mLen) | m;
          eLen += mLen;
          for (
            ;
            eLen > 0;
            buffer[offset + i] = e & 0xff, i += d, e /= 256, eLen -= 8
          ) {}

          buffer[offset + i - d] |= s * 128;
        };
      },
      {}
    ],
    39: [
      function(require, module, exports) {
        exports.endianness = function() {
          return "LE";
        };

        exports.hostname = function() {
          if (typeof location !== "undefined") {
            return location.hostname;
          } else return "";
        };

        exports.loadavg = function() {
          return [];
        };

        exports.uptime = function() {
          return 0;
        };

        exports.freemem = function() {
          return Number.MAX_VALUE;
        };

        exports.totalmem = function() {
          return Number.MAX_VALUE;
        };

        exports.cpus = function() {
          return [];
        };

        exports.type = function() {
          return "Browser";
        };

        exports.release = function() {
          if (typeof navigator !== "undefined") {
            return navigator.appVersion;
          }
          return "";
        };

        exports.networkInterfaces = exports.getNetworkInterfaces = function() {
          return {};
        };

        exports.arch = function() {
          return "javascript";
        };

        exports.platform = function() {
          return "browser";
        };

        exports.tmpdir = exports.tmpDir = function() {
          return "/tmp";
        };

        exports.EOL = "\n";

        exports.homedir = function() {
          return "/";
        };
      },
      {}
    ],
    40: [
      function(require, module, exports) {
        (function(process) {
          // .dirname, .basename, and .extname methods are extracted from Node.js v8.11.1,
          // backported and transplited with Babel, with backwards-compat fixes

          // Copyright Joyent, Inc. and other Node contributors.
          //
          // Permission is hereby granted, free of charge, to any person obtaining a
          // copy of this software and associated documentation files (the
          // "Software"), to deal in the Software without restriction, including
          // without limitation the rights to use, copy, modify, merge, publish,
          // distribute, sublicense, and/or sell copies of the Software, and to permit
          // persons to whom the Software is furnished to do so, subject to the
          // following conditions:
          //
          // The above copyright notice and this permission notice shall be included
          // in all copies or substantial portions of the Software.
          //
          // THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS
          // OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
          // MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN
          // NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
          // DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
          // OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE
          // USE OR OTHER DEALINGS IN THE SOFTWARE.

          // resolves . and .. elements in a path array with directory names there
          // must be no slashes, empty elements, or device names (c:\) in the array
          // (so also no leading and trailing slashes - it does not distinguish
          // relative and absolute paths)
          function normalizeArray(parts, allowAboveRoot) {
            // if the path tries to go above the root, `up` ends up > 0
            var up = 0;
            for (var i = parts.length - 1; i >= 0; i--) {
              var last = parts[i];
              if (last === ".") {
                parts.splice(i, 1);
              } else if (last === "..") {
                parts.splice(i, 1);
                up++;
              } else if (up) {
                parts.splice(i, 1);
                up--;
              }
            }

            // if the path is allowed to go above the root, restore leading ..s
            if (allowAboveRoot) {
              for (; up--; up) {
                parts.unshift("..");
              }
            }

            return parts;
          }

          // path.resolve([from ...], to)
          // posix version
          exports.resolve = function() {
            var resolvedPath = "",
              resolvedAbsolute = false;

            for (
              var i = arguments.length - 1;
              i >= -1 && !resolvedAbsolute;
              i--
            ) {
              var path = i >= 0 ? arguments[i] : process.cwd();

              // Skip empty and invalid entries
              if (typeof path !== "string") {
                throw new TypeError(
                  "Arguments to path.resolve must be strings"
                );
              } else if (!path) {
                continue;
              }

              resolvedPath = path + "/" + resolvedPath;
              resolvedAbsolute = path.charAt(0) === "/";
            }

            // At this point the path should be resolved to a full absolute path, but
            // handle relative paths to be safe (might happen when process.cwd() fails)

            // Normalize the path
            resolvedPath = normalizeArray(
              filter(resolvedPath.split("/"), function(p) {
                return !!p;
              }),
              !resolvedAbsolute
            ).join("/");

            return (resolvedAbsolute ? "/" : "") + resolvedPath || ".";
          };

          // path.normalize(path)
          // posix version
          exports.normalize = function(path) {
            var isAbsolute = exports.isAbsolute(path),
              trailingSlash = substr(path, -1) === "/";

            // Normalize the path
            path = normalizeArray(
              filter(path.split("/"), function(p) {
                return !!p;
              }),
              !isAbsolute
            ).join("/");

            if (!path && !isAbsolute) {
              path = ".";
            }
            if (path && trailingSlash) {
              path += "/";
            }

            return (isAbsolute ? "/" : "") + path;
          };

          // posix version
          exports.isAbsolute = function(path) {
            return path.charAt(0) === "/";
          };

          // posix version
          exports.join = function() {
            var paths = Array.prototype.slice.call(arguments, 0);
            return exports.normalize(
              filter(paths, function(p, index) {
                if (typeof p !== "string") {
                  throw new TypeError("Arguments to path.join must be strings");
                }
                return p;
              }).join("/")
            );
          };

          // path.relative(from, to)
          // posix version
          exports.relative = function(from, to) {
            from = exports.resolve(from).substr(1);
            to = exports.resolve(to).substr(1);

            function trim(arr) {
              var start = 0;
              for (; start < arr.length; start++) {
                if (arr[start] !== "") break;
              }

              var end = arr.length - 1;
              for (; end >= 0; end--) {
                if (arr[end] !== "") break;
              }

              if (start > end) return [];
              return arr.slice(start, end - start + 1);
            }

            var fromParts = trim(from.split("/"));
            var toParts = trim(to.split("/"));

            var length = Math.min(fromParts.length, toParts.length);
            var samePartsLength = length;
            for (var i = 0; i < length; i++) {
              if (fromParts[i] !== toParts[i]) {
                samePartsLength = i;
                break;
              }
            }

            var outputParts = [];
            for (var i = samePartsLength; i < fromParts.length; i++) {
              outputParts.push("..");
            }

            outputParts = outputParts.concat(toParts.slice(samePartsLength));

            return outputParts.join("/");
          };

          exports.sep = "/";
          exports.delimiter = ":";

          exports.dirname = function(path) {
            if (typeof path !== "string") path = path + "";
            if (path.length === 0) return ".";
            var code = path.charCodeAt(0);
            var hasRoot = code === 47; /*/*/
            var end = -1;
            var matchedSlash = true;
            for (var i = path.length - 1; i >= 1; --i) {
              code = path.charCodeAt(i);
              if (code === 47 /*/*/) {
                if (!matchedSlash) {
                  end = i;
                  break;
                }
              } else {
                // We saw the first non-path separator
                matchedSlash = false;
              }
            }

            if (end === -1) return hasRoot ? "/" : ".";
            if (hasRoot && end === 1) {
              // return '//';
              // Backwards-compat fix:
              return "/";
            }
            return path.slice(0, end);
          };

          function basename(path) {
            if (typeof path !== "string") path = path + "";

            var start = 0;
            var end = -1;
            var matchedSlash = true;
            var i;

            for (i = path.length - 1; i >= 0; --i) {
              if (path.charCodeAt(i) === 47 /*/*/) {
                // If we reached a path separator that was not part of a set of path
                // separators at the end of the string, stop now
                if (!matchedSlash) {
                  start = i + 1;
                  break;
                }
              } else if (end === -1) {
                // We saw the first non-path separator, mark this as the end of our
                // path component
                matchedSlash = false;
                end = i + 1;
              }
            }

            if (end === -1) return "";
            return path.slice(start, end);
          }

          // Uses a mixed approach for backwards-compatibility, as ext behavior changed
          // in new Node.js versions, so only basename() above is backported here
          exports.basename = function(path, ext) {
            var f = basename(path);
            if (ext && f.substr(-1 * ext.length) === ext) {
              f = f.substr(0, f.length - ext.length);
            }
            return f;
          };

          exports.extname = function(path) {
            if (typeof path !== "string") path = path + "";
            var startDot = -1;
            var startPart = 0;
            var end = -1;
            var matchedSlash = true;
            // Track the state of characters (if any) we see before our first dot and
            // after any path separator we find
            var preDotState = 0;
            for (var i = path.length - 1; i >= 0; --i) {
              var code = path.charCodeAt(i);
              if (code === 47 /*/*/) {
                // If we reached a path separator that was not part of a set of path
                // separators at the end of the string, stop now
                if (!matchedSlash) {
                  startPart = i + 1;
                  break;
                }
                continue;
              }
              if (end === -1) {
                // We saw the first non-path separator, mark this as the end of our
                // extension
                matchedSlash = false;
                end = i + 1;
              }
              if (code === 46 /*.*/) {
                // If this is our first dot, mark it as the start of our extension
                if (startDot === -1) startDot = i;
                else if (preDotState !== 1) preDotState = 1;
              } else if (startDot !== -1) {
                // We saw a non-dot and non-path separator before our dot, so we should
                // have a good chance at having a non-empty extension
                preDotState = -1;
              }
            }

            if (
              startDot === -1 ||
              end === -1 ||
              // We saw a non-dot character immediately before the dot
              preDotState === 0 ||
              // The (right-most) trimmed path component is exactly '..'
              (preDotState === 1 &&
                startDot === end - 1 &&
                startDot === startPart + 1)
            ) {
              return "";
            }
            return path.slice(startDot, end);
          };

          function filter(xs, f) {
            if (xs.filter) return xs.filter(f);
            var res = [];
            for (var i = 0; i < xs.length; i++) {
              if (f(xs[i], i, xs)) res.push(xs[i]);
            }
            return res;
          }

          // String.prototype.substr - negative index don't work in IE8
          var substr =
            "ab".substr(-1) === "b"
              ? function(str, start, len) {
                  return str.substr(start, len);
                }
              : function(str, start, len) {
                  if (start < 0) start = str.length + start;
                  return str.substr(start, len);
                };
        }.call(this, require("_process")));
      },
      { _process: 41 }
    ],
    41: [
      function(require, module, exports) {
        // shim for using process in browser
        var process = (module.exports = {});

        // cached from whatever global is present so that test runners that stub it
        // don't break things.  But we need to wrap it in a try catch in case it is
        // wrapped in strict mode code which doesn't define any globals.  It's inside a
        // function because try/catches deoptimize in certain engines.

        var cachedSetTimeout;
        var cachedClearTimeout;

        function defaultSetTimout() {
          throw new Error("setTimeout has not been defined");
        }
        function defaultClearTimeout() {
          throw new Error("clearTimeout has not been defined");
        }
        (function() {
          try {
            if (typeof setTimeout === "function") {
              cachedSetTimeout = setTimeout;
            } else {
              cachedSetTimeout = defaultSetTimout;
            }
          } catch (e) {
            cachedSetTimeout = defaultSetTimout;
          }
          try {
            if (typeof clearTimeout === "function") {
              cachedClearTimeout = clearTimeout;
            } else {
              cachedClearTimeout = defaultClearTimeout;
            }
          } catch (e) {
            cachedClearTimeout = defaultClearTimeout;
          }
        })();
        function runTimeout(fun) {
          if (cachedSetTimeout === setTimeout) {
            //normal enviroments in sane situations
            return setTimeout(fun, 0);
          }
          // if setTimeout wasn't available but was latter defined
          if (
            (cachedSetTimeout === defaultSetTimout || !cachedSetTimeout) &&
            setTimeout
          ) {
            cachedSetTimeout = setTimeout;
            return setTimeout(fun, 0);
          }
          try {
            // when when somebody has screwed with setTimeout but no I.E. maddness
            return cachedSetTimeout(fun, 0);
          } catch (e) {
            try {
              // When we are in I.E. but the script has been evaled so I.E. doesn't trust the global object when called normally
              return cachedSetTimeout.call(null, fun, 0);
            } catch (e) {
              // same as above but when it's a version of I.E. that must have the global object for 'this', hopfully our context correct otherwise it will throw a global error
              return cachedSetTimeout.call(this, fun, 0);
            }
          }
        }
        function runClearTimeout(marker) {
          if (cachedClearTimeout === clearTimeout) {
            //normal enviroments in sane situations
            return clearTimeout(marker);
          }
          // if clearTimeout wasn't available but was latter defined
          if (
            (cachedClearTimeout === defaultClearTimeout ||
              !cachedClearTimeout) &&
            clearTimeout
          ) {
            cachedClearTimeout = clearTimeout;
            return clearTimeout(marker);
          }
          try {
            // when when somebody has screwed with setTimeout but no I.E. maddness
            return cachedClearTimeout(marker);
          } catch (e) {
            try {
              // When we are in I.E. but the script has been evaled so I.E. doesn't  trust the global object when called normally
              return cachedClearTimeout.call(null, marker);
            } catch (e) {
              // same as above but when it's a version of I.E. that must have the global object for 'this', hopfully our context correct otherwise it will throw a global error.
              // Some versions of I.E. have different rules for clearTimeout vs setTimeout
              return cachedClearTimeout.call(this, marker);
            }
          }
        }
        var queue = [];
        var draining = false;
        var currentQueue;
        var queueIndex = -1;

        function cleanUpNextTick() {
          if (!draining || !currentQueue) {
            return;
          }
          draining = false;
          if (currentQueue.length) {
            queue = currentQueue.concat(queue);
          } else {
            queueIndex = -1;
          }
          if (queue.length) {
            drainQueue();
          }
        }

        function drainQueue() {
          if (draining) {
            return;
          }
          var timeout = runTimeout(cleanUpNextTick);
          draining = true;

          var len = queue.length;
          while (len) {
            currentQueue = queue;
            queue = [];
            while (++queueIndex < len) {
              if (currentQueue) {
                currentQueue[queueIndex].run();
              }
            }
            queueIndex = -1;
            len = queue.length;
          }
          currentQueue = null;
          draining = false;
          runClearTimeout(timeout);
        }

        process.nextTick = function(fun) {
          var args = new Array(arguments.length - 1);
          if (arguments.length > 1) {
            for (var i = 1; i < arguments.length; i++) {
              args[i - 1] = arguments[i];
            }
          }
          queue.push(new Item(fun, args));
          if (queue.length === 1 && !draining) {
            runTimeout(drainQueue);
          }
        };

        // v8 likes predictible objects
        function Item(fun, array) {
          this.fun = fun;
          this.array = array;
        }
        Item.prototype.run = function() {
          this.fun.apply(null, this.array);
        };
        process.title = "browser";
        process.browser = true;
        process.env = {};
        process.argv = [];
        process.version = ""; // empty string to avoid regexp issues
        process.versions = {};

        function noop() {}

        process.on = noop;
        process.addListener = noop;
        process.once = noop;
        process.off = noop;
        process.removeListener = noop;
        process.removeAllListeners = noop;
        process.emit = noop;
        process.prependListener = noop;
        process.prependOnceListener = noop;

        process.listeners = function(name) {
          return [];
        };

        process.binding = function(name) {
          throw new Error("process.binding is not supported");
        };

        process.cwd = function() {
          return "/";
        };
        process.chdir = function(dir) {
          throw new Error("process.chdir is not supported");
        };
        process.umask = function() {
          return 0;
        };
      },
      {}
    ],
    42: [
      function(require, module, exports) {
        (function(setImmediate, clearImmediate) {
          var nextTick = require("process/browser.js").nextTick;
          var apply = Function.prototype.apply;
          var slice = Array.prototype.slice;
          var immediateIds = {};
          var nextImmediateId = 0;

          // DOM APIs, for completeness

          exports.setTimeout = function() {
            return new Timeout(
              apply.call(setTimeout, window, arguments),
              clearTimeout
            );
          };
          exports.setInterval = function() {
            return new Timeout(
              apply.call(setInterval, window, arguments),
              clearInterval
            );
          };
          exports.clearTimeout = exports.clearInterval = function(timeout) {
            timeout.close();
          };

          function Timeout(id, clearFn) {
            this._id = id;
            this._clearFn = clearFn;
          }
          Timeout.prototype.unref = Timeout.prototype.ref = function() {};
          Timeout.prototype.close = function() {
            this._clearFn.call(window, this._id);
          };

          // Does not start the time, just sets up the members needed.
          exports.enroll = function(item, msecs) {
            clearTimeout(item._idleTimeoutId);
            item._idleTimeout = msecs;
          };

          exports.unenroll = function(item) {
            clearTimeout(item._idleTimeoutId);
            item._idleTimeout = -1;
          };

          exports._unrefActive = exports.active = function(item) {
            clearTimeout(item._idleTimeoutId);

            var msecs = item._idleTimeout;
            if (msecs >= 0) {
              item._idleTimeoutId = setTimeout(function onTimeout() {
                if (item._onTimeout) item._onTimeout();
              }, msecs);
            }
          };

          // That's not how node.js implements it but the exposed api is the same.
          exports.setImmediate =
            typeof setImmediate === "function"
              ? setImmediate
              : function(fn) {
                  var id = nextImmediateId++;
                  var args =
                    arguments.length < 2 ? false : slice.call(arguments, 1);

                  immediateIds[id] = true;

                  nextTick(function onNextTick() {
                    if (immediateIds[id]) {
                      // fn.call() is faster so we optimize for the common use-case
                      // @see http://jsperf.com/call-apply-segu
                      if (args) {
                        fn.apply(null, args);
                      } else {
                        fn.call(null);
                      }
                      // Prevent ids from leaking
                      exports.clearImmediate(id);
                    }
                  });

                  return id;
                };

          exports.clearImmediate =
            typeof clearImmediate === "function"
              ? clearImmediate
              : function(id) {
                  delete immediateIds[id];
                };
        }.call(
          this,
          require("timers").setImmediate,
          require("timers").clearImmediate
        ));
      },
      { "process/browser.js": 41, timers: 42 }
    ],
    43: [
      function(require, module, exports) {
        if (typeof Object.create === "function") {
          // implementation from standard node.js 'util' module
          module.exports = function inherits(ctor, superCtor) {
            ctor.super_ = superCtor;
            ctor.prototype = Object.create(superCtor.prototype, {
              constructor: {
                value: ctor,
                enumerable: false,
                writable: true,
                configurable: true
              }
            });
          };
        } else {
          // old school shim for old browsers
          module.exports = function inherits(ctor, superCtor) {
            ctor.super_ = superCtor;
            var TempCtor = function() {};
            TempCtor.prototype = superCtor.prototype;
            ctor.prototype = new TempCtor();
            ctor.prototype.constructor = ctor;
          };
        }
      },
      {}
    ],
    44: [
      function(require, module, exports) {
        module.exports = function isBuffer(arg) {
          return (
            arg &&
            typeof arg === "object" &&
            typeof arg.copy === "function" &&
            typeof arg.fill === "function" &&
            typeof arg.readUInt8 === "function"
          );
        };
      },
      {}
    ],
    45: [
      function(require, module, exports) {
        (function(process, global) {
          // Copyright Joyent, Inc. and other Node contributors.
          //
          // Permission is hereby granted, free of charge, to any person obtaining a
          // copy of this software and associated documentation files (the
          // "Software"), to deal in the Software without restriction, including
          // without limitation the rights to use, copy, modify, merge, publish,
          // distribute, sublicense, and/or sell copies of the Software, and to permit
          // persons to whom the Software is furnished to do so, subject to the
          // following conditions:
          //
          // The above copyright notice and this permission notice shall be included
          // in all copies or substantial portions of the Software.
          //
          // THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS
          // OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
          // MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN
          // NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
          // DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
          // OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE
          // USE OR OTHER DEALINGS IN THE SOFTWARE.

          var formatRegExp = /%[sdj%]/g;
          exports.format = function(f) {
            if (!isString(f)) {
              var objects = [];
              for (var i = 0; i < arguments.length; i++) {
                objects.push(inspect(arguments[i]));
              }
              return objects.join(" ");
            }

            var i = 1;
            var args = arguments;
            var len = args.length;
            var str = String(f).replace(formatRegExp, function(x) {
              if (x === "%%") return "%";
              if (i >= len) return x;
              switch (x) {
                case "%s":
                  return String(args[i++]);
                case "%d":
                  return Number(args[i++]);
                case "%j":
                  try {
                    return JSON.stringify(args[i++]);
                  } catch (_) {
                    return "[Circular]";
                  }
                default:
                  return x;
              }
            });
            for (var x = args[i]; i < len; x = args[++i]) {
              if (isNull(x) || !isObject(x)) {
                str += " " + x;
              } else {
                str += " " + inspect(x);
              }
            }
            return str;
          };

          // Mark that a method should not be used.
          // Returns a modified function which warns once by default.
          // If --no-deprecation is set, then it is a no-op.
          exports.deprecate = function(fn, msg) {
            // Allow for deprecating things in the process of starting up.
            if (isUndefined(global.process)) {
              return function() {
                return exports.deprecate(fn, msg).apply(this, arguments);
              };
            }

            if (process.noDeprecation === true) {
              return fn;
            }

            var warned = false;
            function deprecated() {
              if (!warned) {
                if (process.throwDeprecation) {
                  throw new Error(msg);
                } else if (process.traceDeprecation) {
                  console.trace(msg);
                } else {
                  console.error(msg);
                }
                warned = true;
              }
              return fn.apply(this, arguments);
            }

            return deprecated;
          };

          var debugs = {};
          var debugEnviron;
          exports.debuglog = function(set) {
            if (isUndefined(debugEnviron))
              debugEnviron = process.env.NODE_DEBUG || "";
            set = set.toUpperCase();
            if (!debugs[set]) {
              if (new RegExp("\\b" + set + "\\b", "i").test(debugEnviron)) {
                var pid = process.pid;
                debugs[set] = function() {
                  var msg = exports.format.apply(exports, arguments);
                  console.error("%s %d: %s", set, pid, msg);
                };
              } else {
                debugs[set] = function() {};
              }
            }
            return debugs[set];
          };

          /**
           * Echos the value of a value. Trys to print the value out
           * in the best way possible given the different types.
           *
           * @param {Object} obj The object to print out.
           * @param {Object} opts Optional options object that alters the output.
           */
          /* legacy: obj, showHidden, depth, colors*/
          function inspect(obj, opts) {
            // default options
            var ctx = {
              seen: [],
              stylize: stylizeNoColor
            };
            // legacy...
            if (arguments.length >= 3) ctx.depth = arguments[2];
            if (arguments.length >= 4) ctx.colors = arguments[3];
            if (isBoolean(opts)) {
              // legacy...
              ctx.showHidden = opts;
            } else if (opts) {
              // got an "options" object
              exports._extend(ctx, opts);
            }
            // set default options
            if (isUndefined(ctx.showHidden)) ctx.showHidden = false;
            if (isUndefined(ctx.depth)) ctx.depth = 2;
            if (isUndefined(ctx.colors)) ctx.colors = false;
            if (isUndefined(ctx.customInspect)) ctx.customInspect = true;
            if (ctx.colors) ctx.stylize = stylizeWithColor;
            return formatValue(ctx, obj, ctx.depth);
          }
          exports.inspect = inspect;

          // http://en.wikipedia.org/wiki/ANSI_escape_code#graphics
          inspect.colors = {
            bold: [1, 22],
            italic: [3, 23],
            underline: [4, 24],
            inverse: [7, 27],
            white: [37, 39],
            grey: [90, 39],
            black: [30, 39],
            blue: [34, 39],
            cyan: [36, 39],
            green: [32, 39],
            magenta: [35, 39],
            red: [31, 39],
            yellow: [33, 39]
          };

          // Don't use 'blue' not visible on cmd.exe
          inspect.styles = {
            special: "cyan",
            number: "yellow",
            boolean: "yellow",
            undefined: "grey",
            null: "bold",
            string: "green",
            date: "magenta",
            // "name": intentionally not styling
            regexp: "red"
          };

          function stylizeWithColor(str, styleType) {
            var style = inspect.styles[styleType];

            if (style) {
              return (
                "\u001b[" +
                inspect.colors[style][0] +
                "m" +
                str +
                "\u001b[" +
                inspect.colors[style][1] +
                "m"
              );
            } else {
              return str;
            }
          }

          function stylizeNoColor(str, styleType) {
            return str;
          }

          function arrayToHash(array) {
            var hash = {};

            array.forEach(function(val, idx) {
              hash[val] = true;
            });

            return hash;
          }

          function formatValue(ctx, value, recurseTimes) {
            // Provide a hook for user-specified inspect functions.
            // Check that value is an object with an inspect function on it
            if (
              ctx.customInspect &&
              value &&
              isFunction(value.inspect) &&
              // Filter out the util module, it's inspect function is special
              value.inspect !== exports.inspect &&
              // Also filter out any prototype objects using the circular check.
              !(value.constructor && value.constructor.prototype === value)
            ) {
              var ret = value.inspect(recurseTimes, ctx);
              if (!isString(ret)) {
                ret = formatValue(ctx, ret, recurseTimes);
              }
              return ret;
            }

            // Primitive types cannot have properties
            var primitive = formatPrimitive(ctx, value);
            if (primitive) {
              return primitive;
            }

            // Look up the keys of the object.
            var keys = Object.keys(value);
            var visibleKeys = arrayToHash(keys);

            if (ctx.showHidden) {
              keys = Object.getOwnPropertyNames(value);
            }

            // IE doesn't make error fields non-enumerable
            // http://msdn.microsoft.com/en-us/library/ie/dww52sbt(v=vs.94).aspx
            if (
              isError(value) &&
              (keys.indexOf("message") >= 0 || keys.indexOf("description") >= 0)
            ) {
              return formatError(value);
            }

            // Some type of object without properties can be shortcutted.
            if (keys.length === 0) {
              if (isFunction(value)) {
                var name = value.name ? ": " + value.name : "";
                return ctx.stylize("[Function" + name + "]", "special");
              }
              if (isRegExp(value)) {
                return ctx.stylize(
                  RegExp.prototype.toString.call(value),
                  "regexp"
                );
              }
              if (isDate(value)) {
                return ctx.stylize(Date.prototype.toString.call(value), "date");
              }
              if (isError(value)) {
                return formatError(value);
              }
            }

            var base = "",
              array = false,
              braces = ["{", "}"];

            // Make Array say that they are Array
            if (isArray(value)) {
              array = true;
              braces = ["[", "]"];
            }

            // Make functions say that they are functions
            if (isFunction(value)) {
              var n = value.name ? ": " + value.name : "";
              base = " [Function" + n + "]";
            }

            // Make RegExps say that they are RegExps
            if (isRegExp(value)) {
              base = " " + RegExp.prototype.toString.call(value);
            }

            // Make dates with properties first say the date
            if (isDate(value)) {
              base = " " + Date.prototype.toUTCString.call(value);
            }

            // Make error with message first say the error
            if (isError(value)) {
              base = " " + formatError(value);
            }

            if (keys.length === 0 && (!array || value.length == 0)) {
              return braces[0] + base + braces[1];
            }

            if (recurseTimes < 0) {
              if (isRegExp(value)) {
                return ctx.stylize(
                  RegExp.prototype.toString.call(value),
                  "regexp"
                );
              } else {
                return ctx.stylize("[Object]", "special");
              }
            }

            ctx.seen.push(value);

            var output;
            if (array) {
              output = formatArray(ctx, value, recurseTimes, visibleKeys, keys);
            } else {
              output = keys.map(function(key) {
                return formatProperty(
                  ctx,
                  value,
                  recurseTimes,
                  visibleKeys,
                  key,
                  array
                );
              });
            }

            ctx.seen.pop();

            return reduceToSingleString(output, base, braces);
          }

          function formatPrimitive(ctx, value) {
            if (isUndefined(value))
              return ctx.stylize("undefined", "undefined");
            if (isString(value)) {
              var simple =
                "'" +
                JSON.stringify(value)
                  .replace(/^"|"$/g, "")
                  .replace(/'/g, "\\'")
                  .replace(/\\"/g, '"') +
                "'";
              return ctx.stylize(simple, "string");
            }
            if (isNumber(value)) return ctx.stylize("" + value, "number");
            if (isBoolean(value)) return ctx.stylize("" + value, "boolean");
            // For some reason typeof null is "object", so special case here.
            if (isNull(value)) return ctx.stylize("null", "null");
          }

          function formatError(value) {
            return "[" + Error.prototype.toString.call(value) + "]";
          }

          function formatArray(ctx, value, recurseTimes, visibleKeys, keys) {
            var output = [];
            for (var i = 0, l = value.length; i < l; ++i) {
              if (hasOwnProperty(value, String(i))) {
                output.push(
                  formatProperty(
                    ctx,
                    value,
                    recurseTimes,
                    visibleKeys,
                    String(i),
                    true
                  )
                );
              } else {
                output.push("");
              }
            }
            keys.forEach(function(key) {
              if (!key.match(/^\d+$/)) {
                output.push(
                  formatProperty(
                    ctx,
                    value,
                    recurseTimes,
                    visibleKeys,
                    key,
                    true
                  )
                );
              }
            });
            return output;
          }

          function formatProperty(
            ctx,
            value,
            recurseTimes,
            visibleKeys,
            key,
            array
          ) {
            var name, str, desc;
            desc = Object.getOwnPropertyDescriptor(value, key) || {
              value: value[key]
            };
            if (desc.get) {
              if (desc.set) {
                str = ctx.stylize("[Getter/Setter]", "special");
              } else {
                str = ctx.stylize("[Getter]", "special");
              }
            } else {
              if (desc.set) {
                str = ctx.stylize("[Setter]", "special");
              }
            }
            if (!hasOwnProperty(visibleKeys, key)) {
              name = "[" + key + "]";
            }
            if (!str) {
              if (ctx.seen.indexOf(desc.value) < 0) {
                if (isNull(recurseTimes)) {
                  str = formatValue(ctx, desc.value, null);
                } else {
                  str = formatValue(ctx, desc.value, recurseTimes - 1);
                }
                if (str.indexOf("\n") > -1) {
                  if (array) {
                    str = str
                      .split("\n")
                      .map(function(line) {
                        return "  " + line;
                      })
                      .join("\n")
                      .substr(2);
                  } else {
                    str =
                      "\n" +
                      str
                        .split("\n")
                        .map(function(line) {
                          return "   " + line;
                        })
                        .join("\n");
                  }
                }
              } else {
                str = ctx.stylize("[Circular]", "special");
              }
            }
            if (isUndefined(name)) {
              if (array && key.match(/^\d+$/)) {
                return str;
              }
              name = JSON.stringify("" + key);
              if (name.match(/^"([a-zA-Z_][a-zA-Z_0-9]*)"$/)) {
                name = name.substr(1, name.length - 2);
                name = ctx.stylize(name, "name");
              } else {
                name = name
                  .replace(/'/g, "\\'")
                  .replace(/\\"/g, '"')
                  .replace(/(^"|"$)/g, "'");
                name = ctx.stylize(name, "string");
              }
            }

            return name + ": " + str;
          }

          function reduceToSingleString(output, base, braces) {
            var numLinesEst = 0;
            var length = output.reduce(function(prev, cur) {
              numLinesEst++;
              if (cur.indexOf("\n") >= 0) numLinesEst++;
              return prev + cur.replace(/\u001b\[\d\d?m/g, "").length + 1;
            }, 0);

            if (length > 60) {
              return (
                braces[0] +
                (base === "" ? "" : base + "\n ") +
                " " +
                output.join(",\n  ") +
                " " +
                braces[1]
              );
            }

            return braces[0] + base + " " + output.join(", ") + " " + braces[1];
          }

          // NOTE: These type checking functions intentionally don't use `instanceof`
          // because it is fragile and can be easily faked with `Object.create()`.
          function isArray(ar) {
            return Array.isArray(ar);
          }
          exports.isArray = isArray;

          function isBoolean(arg) {
            return typeof arg === "boolean";
          }
          exports.isBoolean = isBoolean;

          function isNull(arg) {
            return arg === null;
          }
          exports.isNull = isNull;

          function isNullOrUndefined(arg) {
            return arg == null;
          }
          exports.isNullOrUndefined = isNullOrUndefined;

          function isNumber(arg) {
            return typeof arg === "number";
          }
          exports.isNumber = isNumber;

          function isString(arg) {
            return typeof arg === "string";
          }
          exports.isString = isString;

          function isSymbol(arg) {
            return typeof arg === "symbol";
          }
          exports.isSymbol = isSymbol;

          function isUndefined(arg) {
            return arg === void 0;
          }
          exports.isUndefined = isUndefined;

          function isRegExp(re) {
            return isObject(re) && objectToString(re) === "[object RegExp]";
          }
          exports.isRegExp = isRegExp;

          function isObject(arg) {
            return typeof arg === "object" && arg !== null;
          }
          exports.isObject = isObject;

          function isDate(d) {
            return isObject(d) && objectToString(d) === "[object Date]";
          }
          exports.isDate = isDate;

          function isError(e) {
            return (
              isObject(e) &&
              (objectToString(e) === "[object Error]" || e instanceof Error)
            );
          }
          exports.isError = isError;

          function isFunction(arg) {
            return typeof arg === "function";
          }
          exports.isFunction = isFunction;

          function isPrimitive(arg) {
            return (
              arg === null ||
              typeof arg === "boolean" ||
              typeof arg === "number" ||
              typeof arg === "string" ||
              typeof arg === "symbol" || // ES6 symbol
              typeof arg === "undefined"
            );
          }
          exports.isPrimitive = isPrimitive;

          exports.isBuffer = require("./support/isBuffer");

          function objectToString(o) {
            return Object.prototype.toString.call(o);
          }

          function pad(n) {
            return n < 10 ? "0" + n.toString(10) : n.toString(10);
          }

          var months = [
            "Jan",
            "Feb",
            "Mar",
            "Apr",
            "May",
            "Jun",
            "Jul",
            "Aug",
            "Sep",
            "Oct",
            "Nov",
            "Dec"
          ];

          // 26 Feb 16:19:34
          function timestamp() {
            var d = new Date();
            var time = [
              pad(d.getHours()),
              pad(d.getMinutes()),
              pad(d.getSeconds())
            ].join(":");
            return [d.getDate(), months[d.getMonth()], time].join(" ");
          }

          // log is just a thin wrapper to console.log that prepends a timestamp
          exports.log = function() {
            console.log(
              "%s - %s",
              timestamp(),
              exports.format.apply(exports, arguments)
            );
          };

          /**
           * Inherit the prototype methods from one constructor into another.
           *
           * The Function.prototype.inherits from lang.js rewritten as a standalone
           * function (not on Function.prototype). NOTE: If this file is to be loaded
           * during bootstrapping this function needs to be rewritten using some native
           * functions as prototype setup using normal JavaScript does not work as
           * expected during bootstrapping (see mirror.js in r114903).
           *
           * @param {function} ctor Constructor function which needs to inherit the
           *     prototype.
           * @param {function} superCtor Constructor function to inherit prototype from.
           */
          exports.inherits = require("inherits");

          exports._extend = function(origin, add) {
            // Don't do anything if add isn't an object
            if (!add || !isObject(add)) return origin;

            var keys = Object.keys(add);
            var i = keys.length;
            while (i--) {
              origin[keys[i]] = add[keys[i]];
            }
            return origin;
          };

          function hasOwnProperty(obj, prop) {
            return Object.prototype.hasOwnProperty.call(obj, prop);
          }
        }.call(
          this,
          require("_process"),
          typeof global !== "undefined"
            ? global
            : typeof self !== "undefined"
            ? self
            : typeof window !== "undefined"
            ? window
            : {}
        ));
      },
      { "./support/isBuffer": 44, _process: 41, inherits: 43 }
    ]
  },
  {},
  [34]
);
