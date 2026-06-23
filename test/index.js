var test = require("tape").test

var redisThrottle = require("../")
var RedisTable = redisThrottle.RedisTable
var Throttle = require("tokenthrottle")

/**
 * A minimal in-memory promise-based fake of a redis@4 client.
 * Only implements the commands this module uses (hGetAll, hSet, expire) plus
 * hGet/del for test assertions. hGetAll returns {} for a missing key, exactly
 * like redis@4. Expiry is honored relative to wall-clock seconds.
 */
function FakeRedis() {
  if (!(this instanceof FakeRedis)) return new FakeRedis()
  this.store = Object.create(null)
  this.expiries = Object.create(null)
}

FakeRedis.prototype._sweep = function (key) {
  var exp = this.expiries[key]
  if (exp !== undefined && Date.now() >= exp) {
    delete this.store[key]
    delete this.expiries[key]
  }
}

FakeRedis.prototype.hGetAll = function (key) {
  this._sweep(key)
  var hash = this.store[key]
  // redis@4 returns {} (not null) for a missing key.
  return Promise.resolve(hash ? Object.assign({}, hash) : {})
}

FakeRedis.prototype.hSet = function (key, value) {
  this._sweep(key)
  var hash = this.store[key] || (this.store[key] = Object.create(null))
  var count = 0
  for (var field in value) {
    if (Object.prototype.hasOwnProperty.call(value, field)) {
      hash[field] = String(value[field])
      count++
    }
  }
  return Promise.resolve(count)
}

FakeRedis.prototype.expire = function (key, seconds) {
  this._sweep(key)
  if (this.store[key] === undefined) return Promise.resolve(false)
  this.expiries[key] = Date.now() + seconds * 1000
  return Promise.resolve(true)
}

FakeRedis.prototype.hGet = function (key, field) {
  this._sweep(key)
  var hash = this.store[key]
  return Promise.resolve(hash && hash[field] !== undefined ? hash[field] : null)
}


test("load", function (t) {
  t.plan(2)
  t.ok(redisThrottle, "loaded module")
  t.ok(RedisTable, "exposes RedisTable")
})

test("requires a client", function (t) {
  t.plan(2)
  t.throws(function () { redisThrottle({rate: 100}) }, /redis@4 client/, "throws without a client")
  t.throws(function () { RedisTable() }, /redis@4 client/, "RedisTable throws without a client")
})

test("creates tokenthrottle", function (t) {
  t.plan(1)
  var throttle = redisThrottle({rate: 100}, FakeRedis())
  t.ok(throttle instanceof Throttle, "got a TokenThrottle")
})

test("table get returns null for a missing key (redis@4 {} normalized)", function (t) {
  t.plan(2)
  var table = RedisTable(FakeRedis(), {})
  table.get("nope", function (err, value) {
    t.notOk(err, "No error")
    t.equal(value, null, "missing key normalized to null")
  })
})

test("throttle", function (t) {
  t.plan(8)

  var throttle = redisThrottle({rate: 3, expiry: 6000}, FakeRedis())

  var i = 0
  while (i++ < 3) {
    setTimeout(function () {
      throttle.rateLimit("test", function (err, limited) {
        t.notOk(err, "No error")
        t.notOk(limited, "Not throttled yet")
      })
    }, i * 10)
  }
  setTimeout(function () {
    throttle.rateLimit("test", function (err, limited) {
      t.notOk(err, "No error")
      t.ok(limited, "Should now be throttled.")
    })
  }, 50)
})

test("expires & values set in redis", function (t) {
  t.plan(6)

  var client = FakeRedis()
  var throttle = redisThrottle({rate: 3, expiry: 1}, client)

  throttle.rateLimit("foo", function (err, limited) {
    t.notOk(err, "No error")
    t.notOk(limited, "Not throttled")
    client.hGet("redisThrottle~foo", "time").then(function (value) {
      t.ok(value, "stuff is set in the redis throttle")
    })
    setTimeout(function () {
      client.hGet("redisThrottle~foo", "time").then(function (value) {
        t.notOk(value, "throttle entry is expired")
        return client.hGetAll("redisThrottle~foo")
      }).then(function (all) {
        t.deepEqual(all, {}, "expired key returns {} from hGetAll")
        t.ok(1, "done")
      })
    }, 1100)
  })
})

test("throttle multi-client (shared backing store)", function (t) {
  t.plan(10)

  // Two RedisTable instances sharing the same backing store, mimicking two
  // processes pointed at the same redis.
  var shared = FakeRedis()

  var throttle = redisThrottle({rate: 3, expiry: 10}, shared)
  var throttle2 = redisThrottle({rate: 3, expiry: 10}, shared)

  throttle.rateLimit("multiclient", function (err, limited) {
    t.notOk(err, "No error")
    t.notOk(limited, "Not throttled yet")
  })
  setTimeout(function () {
    throttle2.rateLimit("multiclient", function (err, limited) {
      t.notOk(err, "No error")
      t.notOk(limited, "Not throttled yet")
    })
  }, 10)
  setTimeout(function () {
    throttle.rateLimit("multiclient", function (err, limited) {
      t.notOk(err, "No error")
      t.notOk(limited, "Not throttled yet")
    })
  }, 20)
  setTimeout(function () {
    throttle.rateLimit("multiclient", function (err, limited) {
      t.notOk(err, "No error")
      t.ok(limited, "Should now be throttled.")
    })
    throttle2.rateLimit("multiclient", function (err, limited) {
      t.notOk(err, "No error")
      t.ok(limited, "Should now be throttled from here as well.")
    })
  }, 50)
})

test("Override", function (t) {
  t.plan(8)
  var throttle = redisThrottle({
    rate: 3,
    burst: 3,
    overrides: {
      test: {rate: 0, burst: 0}
    }
  }, FakeRedis())
  var i = 0
  while (i++ < 3) {
    setTimeout(function () {
      throttle.rateLimit("test", function (err, limited) {
        t.notOk(err)
        t.notOk(limited, "Not throttled yet")
      })
    }, i * 10)
  }
  setTimeout(function () {
    throttle.rateLimit("test", function (err, limited) {
      t.notOk(err)
      t.notOk(limited, "This one never gets throttled.")
    })
  }, 50)
})

test("Override rate only", function (t) {
  t.plan(8)
  var throttle = redisThrottle({
    rate: 3,
    burst: 3,
    overrides: {
      test: {rate: 0}
    }
  }, FakeRedis())
  var i = 0
  while (i++ < 3) {
    setTimeout(function () {
      throttle.rateLimit("test", function (err, limited) {
        t.notOk(err)
        t.notOk(limited, "Not throttled yet")
      })
    }, i * 10)
  }
  setTimeout(function () {
    throttle.rateLimit("test", function (err, limited) {
      t.notOk(err)
      t.notOk(limited, "This one never gets throttled.")
    })
  }, 50)
})

test("propagates redis errors via callback", function (t) {
  t.plan(2)
  var client = FakeRedis()
  client.hGetAll = function () { return Promise.reject(new Error("boom")) }
  var table = RedisTable(client, {})
  table.get("x", function (err, value) {
    t.ok(err, "error propagated")
    t.notOk(value, "no value")
  })
})
