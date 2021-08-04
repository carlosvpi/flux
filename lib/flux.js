class Flux {
  constructor (value, handler = () => {}) {
    this._value = value
    this._done = false
    this._subscriptions = new Set()
    handler(this.publish.bind(this), this.end.bind(this), this.update.bind(this), this)
  }
  getValue () {
    return this._value
  }
  isDone () {
    return this._done
  }
  publish (value) {
    if (this._done) { return }
    this._value = value
    this._subscriptions.forEach(subscription =>
      subscription(this._value, this._done)
    )
    return this
  }
  update (f) {
    this.publish(f(this._value))
    return this
  }
  end () {
    if (this._done) { return }
    this._done = true
    this._subscriptions.forEach(subscription =>
      subscription(this._value, this._done)
    )
    this._subscriptions = null
    return this
  }
  forEach (f) {
    if (this._done) { return }
    const subscription = (...args) => {
      if (!this._done) {
        f(this._value)
      }
    }
    this._subscriptions.add(subscription)
    return subscription
  }
  pullSubscribe (f) {
    if (this._done) { return }
    this._subscriptions.add(f)
    f(this._value)
    return this
  }
  subscribe (f) {
    if (this._done) { return }
    this._subscriptions.add(f)
    return this
  }
  unsubscribe (f) {
    if (this._done) { return }
    return this._subscriptions.delete(f)
  }
  next (f) {
    const oneOff = (...args) => {
      f(...args)
      this.unsubscribe(oneOff)
    }
    this.forEach(oneOff)
    return this
  }
  last (f) {
    this.subscribe((value, done) => {
      if (done) {
        f(this)
      }
    })
    return this
  }
  [Symbol.asyncIterator]() {
    return {
      next: () => {
        return new Promise(resolve => {
          this.next((value, done) => {
            resolve({ value: this._value, done: this._done })
          })
        })
      }
    }
  }
  map (f) {
    return new Flux(f(this._value), (push, end) => {
      this.forEach(value => push(f(value)))
      this.last(end)
    })
  }
  reduce (f, dflt) {
    return new Flux(dflt, (push, end, _, flux) => {
      this.forEach(value => push(f(value, flux._value)))
      this.last(end)
    })
  }
  filter (p) {
    return new Flux(p(this._value) ? this._value : undefined, (push, end) => {
      this.forEach(value => p(value) && push(value))
      this.last(end)
    })
  }
  reject (p) {
    return new Flux(!p(this._value) ? this._value : undefined, (push, end) => {
      this.forEach(value => !p(value) && push(value))
      this.last(end)
    })
  }
  compact (p) {
    return this.reject(value => value === undefined || value === null)
  }
  mergeRace (...fluxes) {
    return new Flux(this._value, (push, end) => {
      [this, ...fluxes].forEach(flux => {
        flux.forEach(push)
        flux.last(end)
      })
    })
  }
  mergeAll (...fluxes) {
    return new Flux(this._value, (push, end) => {
      [this, ...fluxes].forEach(flux => {
        flux.forEach(push)
        flux.last(() => {
          if ([this, ...fluxes].every(flux => flux.isDone())) {
            end()
          }
        })
      })
    })
  }
  toPromise () {
    return new Promise(resolve => {
      this.next(resolve)
    })
  }
  throttle (ms) {
    return new Flux(this._value, (publish, end, _, flux) => {
      let throttling = false
      let token
      this.last(() => {
        end()
        if (token) {
          clearTimeout(token)
        }
      })
      this.forEach(value => {
        if (throttling) { return }
        publish(value)
        throttling = true
        token = setTimeout(() => {
          throttling = false
        }, ms)
      })
    })
  }
  debounce (ms) {
    return new Flux(this._value, (publish, end, _, flux) => {
      let token
      this.last(end)
      this.forEach(value => {
        if (token) { clearTimeout(token) }
        token = setTimeout(() => {
          publish(value)
        }, ms)
      })
    })
  }
}

Flux.fromPromise = (promiser) => {
  return new Flux(async (push, end) => {
    push(await promiser)
    end()
  })
}
Flux.fromInterval = (ms) => {
  return new Flux(null, (push, end, _, flux) => {
    const token = setInterval(push, ms)
    flux.last(() => clearInterval(token))
  })
}
Flux.fromTimeout = (ms) => {
  return new Flux(null, (push, end, _, flux) => {
    const token = setTimeout(push, ms)
    flux.last(() => clearTimeout(token))
  })
}
Flux.fromAnimationFrame = (ms) => {
  return new Flux(null, (push, end, _, flux) => {
    let token
    const handler = (...args) => {
      push(...args)
      token = requestAnimationFrame(handler)
    }
    token = requestAnimationFrame(handler, ms)
    flux.last(() => cancelAnimationFrame(token))
  })
}
Flux.fromEvent = (node, eventName, bubbling) => {
  return new Flux(null, (push, end, _, flux) => {
    node.addEventListener(eventName, push, bubbling)
    flux.last(() => {
      node.removeEventListener(eventName, push, bubbling)
    })
  })
}
Flux.aggregate = (structure) => {
  const aggregator = new Aggregator(structure.constructor)
  for (let key in structure) {
    aggregator(structure[key])
  }
  return aggregator
}

class Aggregator extends Flux {
  constructor (constructor) {
    super(new constructor())
    this._structure = new constructor()
    this._structureSubscriptions = new constructor()
    this._constructor = constructor
  }
  get (key) {
    return this._structure[key]
  }
  set (key, flux) {
    if (this._constructor === Array) {
      throw new Error('Cannot use "set" for array aggregator')
    }
    this._structure[key] = flux
    this._value[key] = flux.getValue()
    this.publish(this._value)
    this._structureSubscriptions[key] = flux.forEach(value => {
      this._value[key] = value
    })
    return this
  }
  push (flux) {
    if (this._constructor !== Array) {
      throw new Error('Cannot use "push" for hash aggregator')
    }
    const index = this._structure.length
    this._structure.push(flux)
    this._value.push(flux.getValue())
    this.publish(this._value)
    this._structureSubscriptions.push(flux.forEach(value => {
      this._value[index] = value
    }))
    return this
  }
  delete (key) {
    if (key in this._structure) {
      this._structure[key].unsubscribe(this._structureSubscriptions[key])
      if (Array.isArray(this._structure)) {
        this._structure.splice(key, 1)
        this._value.splice(key, 1)
      } else {
        delete this._structure[key]
        delete this._value[key]
      }
      this.publish(this._value)
      return true
    }
  }
  remove (flux) {
    let key
    for (key in this._structure) {
      if (this._structure[key] === flux) {
        this.delete(key)
        return true
      }
    }
    return false
  }
}

module.exports.Flux = Flux
