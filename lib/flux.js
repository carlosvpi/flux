class Flux {
  constructor (builder, cleaner) {
    this._value = undefined
    this._done = false
    this._subscriptions = new Set([])
    this._cleanerArg = builder && builder.call(this, this.push.bind(this), this.end.bind(this), this.value.bind(this))
    this._cleaner = cleaner && cleaner.bind(this)
    this.pop = this.pop.bind(this)
  }
  value () {
    return this._value
  }
  done () {
    return this._done
  }
  touch () {
    if (this._done) return this
    this._subscriptions.forEach(subscription => subscription(this._value, this._done))
    return this
  }
  push (value) {
    if (this._done) return this
    this._value = value
    this._subscriptions.forEach(subscription => subscription(this._value, this._done))
    return this
  }
  end () {
    if (this._done) return this
    this._done = true
    this._subscriptions.forEach(subscription => subscription(this._value, this._done))
    delete this._subscriptions
    this.cleaner && this.cleaner(this._cleanerArg)
    return this
  }
  pushEnd (value, done) {
    if (done) {
      this.end()
    } else {
      this.push(value)
    }
    return this
  }
  pop (...subscriptions) {
    subscriptions.forEach(subscription => {
      this.subscribe(subscription)
      subscription(this._value, this._done)
    })
    return this
  }
  subscribe (...subscriptions) {
    if (this._done) return this
    subscriptions.forEach(subscription => this._subscriptions.add(subscription))
    return this
  }
  unsubscribe (...subscriptions) {
    if (this._done) return this
    subscriptions.forEach(subscription => this._subscriptions.delete(subscription))
    return this
  }
  map (f) {
    return new Flux((push, end) => {
      push(f(this._value))
      this.subscribe((value, done) => {
        done ? end() : push(f(value))
      })
    })
  }
  reduce (f, d) {
    return new Flux((push, end, v) => {
      push(d)
      this.subscribe((value, done) => {
        (done ? end : push)(f(v(), value))
      })
    })
  }
  filter (p) {
    return new Flux((push, end, v) => {
      p(this._value) && push(this._value)
      this.subscribe((value, done) => {
        done && end()
        p(value) && push(value)
      })
    })
  }
  compact () {
    return this.filter(value => !!value)
  }
  reject (p) {
    return new Flux((push, end, v) => {
      !p(this._value) && push(this._value)
      this.subscribe((value, done) => {
        done && end()
        !p(value) && push(value)
      })
    })
  }
  last (n) {
    return new Flux((push, end, v) => {
      push([])
      this.subscribe((value, done) => {
        let current = v()
        if (current.length === n) {
          current = current.slice(0, current.length - 1)
        }
        (done ? end : push)([value, ...current])
      })
    })
  }
  toPromise () {
    return new Promise((resolve, reject) => {
      const subscription = (value, done) => {
        !done && resolve(value)
        done && reject(value)
        this.unsubscribe(subscription)
      }
      this.subscribe(subscription)
    })
  }
  mergeRace (...fluxes) {
    return Flux.mergeRace(this, ...fluxes)
  }
  mergeAll (...fluxes) {
    return Flux.mergeAll(this, ...fluxes)
  }
  debounce (ms) {
    return new Flux((push, end, v) => {
      let token = null
      this.subscribe((value, done) => {
        if (token !== null) clearTimeout(token)
        if (done) {
          end()
          return
        }
        token = setTimeout(() => {
          push(value)
        }, ms)
      })
    })
  } 
  throttle (ms) {
    return new Flux((push, end, v) => {
      let token = null
      let lastValue = null
      this.subscribe((value, done) => {
        if (done) {
          if (token) {
            push(lastValue)
            clearTimeout(token)
          }
          end()
          return
        }
        if (token === null) {
          lastValue = value
          push(lastValue)
          token = setTimeout(() => {
          }, ms)
        }
      })
    })
  }
}
Flux.mergeRace = (...fluxes) => {
  return new Flux((push, end, v) => {
    fluxes.forEach(flux => {
      flux.subscribe((value, done) => {
        done ? end() : push(value)
      })
    })
  })
}
Flux.mergeAll = (...fluxes) => {
  return new Flux((push, end, v) => {
    fluxes.forEach(flux => {
      flux.subscribe((value, done) => {
        fluxes.every(flux => flux.done()) ? end() : push(value)
      })
    })
  })
}
Flux.fromTimeout = ms => Flux.fromPromiseFactory(clearer => {
  const p = wait(ms)
  clearer.clear = p.cancel
  return p
})
Flux.fromInterval = ms => {
  return new Flux(push => setInterval(push, ms), token => clearInterval(token))
}
Flux.fromPromiseFactory = promiseFactory => {
  const clearer = {clear:() => {}}
  return new Flux(async (push) => {
    push(await promiseFactory(clearer))
  }, () => {
    clearer.clear()
  })
}
Flux.push = value => push => push(value)
Flux.fromEvent = (node, eventName, useCapture) => {
  return new Flux(push => {
    node.addEventListener(eventName, push, useCapture)
  }, () => {
    node.removeEventListener(eventName, push, useCapture)
  })
}
Flux.compound = (...fluxes) => {
  return new Flux((push, end, value) => {
    push(fluxes.map(str => str.value()))
    fluxes.forEach(str => {
      str.subscribe(() => push(fluxes.map(str => str.value())))
    })
  })
}

Flux.collect = xx => {
  return new Flux(function (push, end, getValue) {
    push([])
    xx.subscribe((x, done) => {
      push([...getValue(), x])
      x.subscribe(Flux.onDone(() => {
        push(getValue().filter(_x => _x !== x))
      }), Flux.onContinue(() => {
        this.touch()
      }))
    })
  })
}

Flux.onContinue = f => (value, done) => !done && f(value)
Flux.onDone = f => (value, done) => done && f(value)

const wait = ms => {
  let _token
  let _reject
  const p = new Promise((resolve, reject) => {
    _reject = reject
    _token = setTimeout(() => {
      _token = null
      resolve()
    }, ms)
  })
  p.cancel = () => {
    if (!_token) return false
    clearTimeout(_token)
    _reject()
    return true
  }
  return p
}

module.exports = Flux