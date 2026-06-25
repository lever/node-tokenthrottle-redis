module.exports = redisThrottle
module.exports.RedisTable = RedisTable

var Throttle = require("tokenthrottle")

/**
 * A npm.im/tokenthrottle implementation on top of Redis
 * @param  {Object} options          [REQUIRED] The same options as npm.im/tokenthrottle, plus:
 *                                   - expiry: the number of seconds to expire untouched entires (optional)
 *                                   - prefix: an optional namespace prefix for the key (optional)
 * @param  {RedisClient} redisClient A connected redis@4 client to use. REQUIRED.
 * @return {TokenThrottle}           A token throttle backed by Redis
 */
function redisThrottle(options, redisClient) {
  if (!options) throw new Error("Please supply required options.")
  if (!redisClient) throw new Error("Please supply a connected redis@4 client.")
  options.tokensTable = RedisTable(redisClient, options)
  return Throttle(options)
}

/**
 * A Redis TokenTable implementation backed by a redis@4 (promise-based) client.
 *
 * The public get/put API remains callback-based: tokenthrottle detects the table
 * type by function arity (get => (key, cb), put => (key, value, cb)) and invokes
 * these methods with a Node-style callback. Internally we use the redis@4 promise
 * API and bridge the result/error back to that callback.
 *
 * @param {RedisClient} redisClient A connected redis@4 client to use. REQUIRED.
 * @param {Options} options RedisTable options
 *                          - expiry: Number of seconds to expire untouched entries (optional)
 *                          - prefix: A string to prefix all token entries with (default 'redisThrottle')
 */
function RedisTable(redisClient, options) {
  if (!(this instanceof RedisTable)) return new RedisTable(redisClient, options)
  if (!redisClient) throw new Error("Please supply a connected redis@4 client.")
  this.client = redisClient
  options = options || {}
  this.expiry = options.expiry
  this.prefix = options.prefix || "redisThrottle"
}

RedisTable.prototype._key = function (key) {
  return [this.prefix, key].join("~")
}

RedisTable.prototype.get = function (key, cb) {
  var myKey = this._key(key)
  this.client
    .hGetAll(myKey)
    .then(function (value) {
      // redis@4 returns {} for a missing key. tokenthrottle expects a falsy
      // value when there is no existing bucket, so normalize empty -> null.
      if (!value || Object.keys(value).length === 0) value = null
      cb(null, value)
    })
    .catch(cb)
  if (this.expiry) {
    this.client.expire(myKey, this.expiry).catch(function () {
      // Best-effort expiry refresh; failures here must not affect throttling.
    })
  }
}

RedisTable.prototype.put = function (key, value, cb) {
  var myKey = this._key(key)
  this.client
    .hSet(myKey, value)
    .then(function () {
      cb(null)
    })
    .catch(cb)
  if (this.expiry) {
    this.client.expire(myKey, this.expiry).catch(function () {
      // Best-effort expiry refresh; failures here must not affect throttling.
    })
  }
}
