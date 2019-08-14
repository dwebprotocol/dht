'use strict'
const assert = require('assert')
const {
  crypto_generichash: hash,
  crypto_sign_keypair: createKeypair,
  crypto_sign_verify_detached: verify,
  crypto_sign_detached: sign,
  crypto_sign_PUBLICKEYBYTES: pkSize,
  crypto_sign_SECRETKEYBYTES: skSize,
  crypto_sign_BYTES: signSize,
  randombytes_buf: randomBytes
} = require('sodium-universal')
const { Mutable } = require('./messages')
const { PassThrough } = require('stream')
const finished = require('end-of-stream')

// PUT_VALUE_MAX_SIZE + packet overhead (i.e. the key etc.)
// should be less than the network MTU, normally 1400 bytes
const PUT_VALUE_MAX_SIZE = 1000

class ImmutableStore {
  constructor (dht, store) {
    this.dht = dht
    this.store = store
  }

  get (key, cb) {
    assert(Buffer.isBuffer(key), 'Key must be a buffer')
    const { store, dht } = this
    // if the querying node already has the immutable value
    // then there's no need to query the dht
    const hasCb = typeof cb === 'function'
    const hexKey = key.toString('hex')
    const value = store.get(hexKey)
    if (value && hasCb) {
      const { id } = this.dht
      const localStream = PassThrough({ objectMode: true })
      finished(localStream, (err) => {
        if (err) {
          cb(err)
          return
        }
        cb(null, value, { id })
      })
      localStream.end({ id, value })
      process.nextTick(() => localStream.resume())
      return localStream
    }

    let found = false
    const queryStream = dht.query('immutable-store', key).map((result) => {
      if (!result.value) return
      const { value } = result
      const check = Buffer.alloc(32)
      hash(check, value)
      if (Buffer.compare(check, key) !== 0) return
      const { node } = result
      return { id: node.id, value }
    })
    if (value && hasCb === false) {
      // push local cached value out of stream first
      process.nextTick(() => {
        const { id } = this.dht
        queryStream.emit('data', { id, value })
      })
    }
    if (hasCb) {
      queryStream.once('data', ({ id, value }) => {
        found = true
        cb(null, value, { id })
        queryStream.destroy()
      })
      finished(queryStream, (err) => {
        if (err) {
          cb(err)
          return
        }
        if (found === false) cb(null, null, null)
      })
    }
    return queryStream
  }

  put (value, cb) {
    assert(Buffer.isBuffer(value), 'Value must be a buffer')
    assert(
      value.length <= PUT_VALUE_MAX_SIZE,
      `Value size must be <= ${PUT_VALUE_MAX_SIZE}`
    )
    assert(typeof cb === 'function', 'Callback is required')
    const { store, dht } = this
    const key = Buffer.alloc(32)
    hash(key, value)
    // set locally for easy cached retrieval
    store.set(key.toString('hex'), value)

    // send to the dht
    const queryStream = dht.update('immutable-store', key, value)
    queryStream.resume()
    finished(queryStream, (err) => {
      if (err) {
        cb(err)
        return
      }
      cb(null, key)
    })

    return queryStream
  }

  _command () {
    const { store } = this
    return {
      update ({ target, value }, cb) {
        const key = Buffer.alloc(32)
        hash(key, value)
        if (Buffer.compare(key, target) !== 0) {
          cb(Error('ERR_INVALID_INPUT'))
          return
        }
        store.set(key.toString('hex'), value)
        cb(null)
      },
      query ({ target }, cb) {
        cb(null, store.get(target.toString('hex')))
      }
    }
  }
}
class MutableStore {
  constructor (dht, store) {
    this.dht = dht
    this.store = store
  }

  salt (size = 32) {
    assert(
      size >= 16 && size <= 64,
      'salt size must be between 16 and 64 bytes (inclusive)'
    )
    const salt = Buffer.alloc(size)
    randomBytes(salt)
    return salt
  }

  keypair () {
    const publicKey = Buffer.alloc(pkSize)
    const secretKey = Buffer.alloc(skSize)
    createKeypair(publicKey, secretKey)
    return { publicKey, secretKey }
  }

  sign (value, opts) {
    assert(typeof opts === 'object', 'Options are required')
    assert(Buffer.isBuffer(value), 'Value must be a buffer')
    assert(value.length <= PUT_VALUE_MAX_SIZE, `Value size must be <= ${PUT_VALUE_MAX_SIZE}`)
    const { keypair } = opts
    assert(keypair, 'keypair is required')
    const { secretKey, publicKey } = keypair
    assert(Buffer.isBuffer(secretKey), 'keypair.secretKey is required')
    assert(Buffer.isBuffer(publicKey), 'keypair.publicKey is required')
    const msg = this.signable(value, opts)
    const signature = Buffer.alloc(signSize)
    sign(signature, msg, secretKey)
    return signature
  }

  signable (value, opts = {}) {
    const { salt } = opts
    assert(Buffer.isBuffer(value), 'Value must be a buffer')
    assert(value.length <= PUT_VALUE_MAX_SIZE, `Value size must be <= ${PUT_VALUE_MAX_SIZE}`)
    if (!salt) return value
    assert(Buffer.isBuffer(salt), 'salt must be a buffer')
    assert(
      salt.length >= 16 && salt.length <= 64,
      'salt size must be between 16 and 64 bytes (inclusive)'
    )
    return Buffer.concat([Buffer.from([salt.length]), salt, value])
  }

  get (key, opts = {}, cb = opts) {
    const { dht } = this
    const { salt, seq = 0 } = opts
    assert(Buffer.isBuffer(key), 'Key must be a buffer')
    assert(typeof seq === 'number', 'seq should be a number')
    if (salt) {
      assert(Buffer.isBuffer(salt), 'salt must be a buffer')
      assert(
        salt.length >= 16 && salt.length <= 64,
        'salt size must be between 16 and 64 bytes (inclusive)'
      )
    }
    const queryStream = dht.query('mutable-store', key, { salt, seq })
      .map((result) => {
        if (!result.value) return
        const { value, signature, seq: storedSeq } = result.value
        const msg = salt
          ? Buffer.concat([Buffer.from([salt.length]), salt, value])
          : value
        if (storedSeq >= userSeq && verify(signature, msg, key)) {
          const id = result.node.id
          return { id, value, signature, seq: storedSeq, salt }
        }
      })
    let found = false
    const hasCb = typeof cb === 'function'
    const userSeq = seq
    if (hasCb) {
      queryStream.once('data', (info) => {
        found = true
        cb(null, info)
        queryStream.destroy()
      })
      finished(queryStream, (err) => {
        if (err) {
          cb(err)
          return
        }
        if (found === false) cb(null, { value: null })
      })
    }
    return queryStream
  }

  put (value, opts, cb) {
    assert(Buffer.isBuffer(value), 'Value must be a buffer')
    assert(typeof opts === 'object', 'Options are required')
    assert(typeof cb === 'function', 'Callback is required')
    assert(value.length <= PUT_VALUE_MAX_SIZE, `Value size must be <= ${PUT_VALUE_MAX_SIZE}`)
    const { dht } = this
    const { seq = 0, salt, keypair, signature = this.sign(value, opts) } = opts
    if (opts.signature) {
      assert(keypair, 'keypair is required')
      const { secretKey, publicKey } = keypair
      assert(Buffer.isBuffer(publicKey), 'keypair.publicKey is required')
      assert(!secretKey, 'only opts.signature OR opts.keypair.secretKey should be supplied')
    }
    const { publicKey: key } = keypair
    assert(typeof seq === 'number', 'seq should be a number')
    const queryStream = dht.update('mutable-store', key, {
      value, signature, seq, salt
    })
    queryStream.resume()
    finished(queryStream, (err) => {
      if (err) {
        cb(err)
        return
      }
      cb(null, { key, signature, seq, salt })
    })

    return queryStream
  }

  _command () {
    const { store } = this
    return {
      valueEncoding: Mutable,
      update (input, cb) {
        if (input.value.value == null || input.value.signature == null) {
          cb(null)
          return
        }
        const publicKey = input.target
        const { value, salt, signature, seq } = input.value
        const key = salt
          ? publicKey.toString('hex') + salt.toString('hex')
          : publicKey.toString('hex')
        const local = store.get(key)

        const msg = salt
          ? Buffer.concat([Buffer.from([salt.length]), salt, value])
          : value

        if (local && local.seq === seq && Buffer.compare(local.value, value) !== 0) {
          cb(Error('ERR_INVALID_SEQ'))
          return
        }
        const verified = verify(signature, msg, publicKey) &&
          (local ? seq > local.seq : true)

        if (verified === false) {
          cb(Error('ERR_INVALID_INPUT'))
          return
        }
        store.set(key, { value, salt, signature, seq })
        cb(null)
      },
      query ({ target, value }, cb) {
        const { seq, salt } = value
        const key = salt
          ? target.toString('hex') + salt.toString('hex')
          : target.toString('hex')
        const result = store.get(key)
        if (result && result.seq >= seq) {
          cb(null, result)
        } else {
          cb(null, null)
        }
      }
    }
  }
}

module.exports = {
  ImmutableStore, MutableStore
}
