import { printError } from './cli.mjs'

function Group(e, name) {
  this.e = e
  this.name = name
  this.hasExclusive = false
  this.parent = null
  this.groups = []
  this.tests = []
  this.customTimeout = null
  this.skipTest = false
  this.isExclusive = false
  this.before = null
  this.after = null
}

Group.prototype.timeout = function(time) {
  this.customTimeout = time
}

Group.prototype.skip = function() {
  this.skipTest = true
}

Group.prototype.__hasonly = function(markHas) {
  if (this.skipTest) return

  // Set hasExclusive with either mark or existing value
  // Some groups might have .only() but that doesn't mean
  // the children have .only() buut they should still be run
  this.hasExclusive = this.hasExclusive || markHas

  // Travel upwards to the root mark all the groups along the way
  let g = this.parent
  while (g) {
    // If the parent has skipped marked, we definitely don't wanna
    // mark that we have tests with exclusivity on.
    if (g.skipTest) return

    g.hasExclusive = true
    g = g.parent
  }

  this.e.hasExclusive = true
}

Group.prototype.only = function() {
  this.isExclusive = true
  this.__hasonly(false)
}

function Test(e, group, name, func) {
  this.e = e
  this.group = group
  this.skipTest = false
  this.isExclusive = false
  this.customTimeout = null
  this.isBasic = false
  this.name = name
  this.func = func
  this.error = null
}

Test.prototype.timeout = function(time) {
  this.customTimeout = time
}

Test.prototype.skip = function() {
  this.skipTest = true
}

Test.prototype.only = function() {
  this.isExclusive = true
  this.group.__hasonly(true)
}

function Eltro() {
  this.__timeout = 2000
  this.hasExclusive = false
  this.reporter = 'list'
  this.Eltro = Eltro
  this.fileGroupMap = new Map()
  this.groups = []
  this.activeGroup = null
  this.failedTests = []
  this.hasTests = false
  this.starting = false
  this.filename = ''
  this.prefix = ''
  this.temporary = {
    timeout: 0,
    skip: false,
    only: false
  }
  this.describeTemporary = {
    timeout: 0,
    skip: false,
    only: false
  }
}

Eltro.prototype.begin = function() {
  if (this.starting) {
    console.warn('WARNING: Multiple calls to Eltro.begin were done.')
    return
  }
  this.hasTests = false
  this.starting = true
  this.filename = ''
  this.prefix = ''
  this.fileGroupMap.clear()
}

Eltro.prototype.__runTest = async function(stats, test, prefix = 'Test') {
  if (this.reporter === 'list') {
    process.stdout.write('    \x1b[90m? ' + test.name + '\x1b[0m')
  }

  if (!test.skipTest) {
    await new Promise((resolve, reject) => {
      // Flag to check if we finished
      let finished = false
      let timeout = test.customTimeout || this.__timeout

      // Timeout timer in case test times out
      let timer = setTimeout(function() {
        if (finished === true) return
        reject(new Error('timeout of ' + timeout + 'ms exceeded. Ensure the done() callback is being called in this test.'))
      }, timeout)

      // start the test runner
      try {
        // Does it accept a callback
        let checkIsCallback = (test.func.toString()).match(/^(function)? *\([^\)]+\)/)
        let promise

        // If the test requires callback, wrap it in a promise where callback
        // either resolves or rejects that promise
        if (checkIsCallback) {
          promise = new Promise(function(res, rej) {
            test.func(function(err) {
              if (err) {
                return rej(err)
              }
              res()
            })
          })
        } else {
          // Function doesn't require a callback, run it directly
          promise = test.func()
        }

        // Check if the function we ran returned a promise
        if (promise && promise.then && typeof(promise.then === 'function')) {
          // If the promise from the function succeeded, resolve our promise.
          // Otherwise reject it
          promise.then(function() {
            // check if our test had already finished and if so, do nothing
            if (finished === true) return

            finished = true
            clearTimeout(timer)
            resolve()
          }, function(err) {
            // check if our test had already finished and if so, do nothing
            if (finished === true) return

            finished = true
            clearTimeout(timer)
            reject(err)
          })
        } else {
          // check if our test had already finished and if so, do nothing
          if (finished === true) return

          // Possible this was a synchronous test, pass immediately
          finished = true
          clearTimeout(timer)
          resolve()
        }
      } catch (err) {
        // check if our test had already finished and if so, do nothing
        if (finished === true) return

        // An error occured while running function. Possible exception
        // during a synchronous test or something else.
        finished = true
        clearTimeout(timer)
        reject(err)
      }
    })
    .then(function() {
        if (prefix === 'Test') {
          stats.passed++
        }
      }, function(err) {
        let saveError = err
        if (!saveError) {
          saveError = new Error(prefix + ' promise rejected with empty message')
        } else if (typeof(saveError) !== 'object' || saveError.message == null || saveError.stack == null) {
          try {
            saveError = new Error(prefix + ' promise rejected with ' + JSON.stringify(saveError))
          } catch (parseError) {
            saveError = new Error(prefix + ' promise rejected with ' + saveError + ' (Error stringifying: ' + parseError.message + ')')
          }
          saveError.originalError = err
        }
        test.error = saveError
        stats.failed++
      }
    )
  } else {
    stats.skipped++
  }

  if (test.error) {
    this.failedTests.push(test)
  }

  if (this.reporter === 'list') {
    process.stdout.clearLine();
    process.stdout.cursorTo(0);
    if (test.skipTest) {
      process.stdout.write('    \x1b[94m- ' + test.name + '\x1b[0m\n')
    } else if (!test.error) {
      process.stdout.write('    \x1b[32m√\x1b[90m ' + test.name + '\x1b[0m\n')
    } else if (prefix === 'Test') {
      process.stdout.write('    \x1b[31m' + this.failedTests.length + ') ' + test.name + '\x1b[0m\n')
    }
  } else if (this.reporter === 'dot') {
    if (test.skipTest) {
      process.stdout.write('\x1b[94m.\x1b[0m')
    } else if (!test.error) {
      process.stdout.write('\x1b[32m.\x1b[0m')
    } else if (prefix === 'Test') {
      process.stdout.write('\x1b[31m.\x1b[0m')
    }
  }
}

Eltro.prototype.__runGroup = async function(g, stats) {
  if (g.tests.length) {
    if (this.reporter === 'list') {
      console.log('  ' + g.name)
    }
  }
  if (g.before) {
    await this.__runTest(stats, g.before, 'Before')
    if (g.before.error) return
  }
  for (let x = 0; x < g.tests.length; x++) {
    if (!g.tests[x].skipTest && g.tests[x].isExclusive === g.hasExclusive) {
      await this.__runTest(stats, g.tests[x])
    }
  }
  for (let x = 0; x < g.groups.length; x++) {
    if (!g.groups[x].skipTest && g.hasExclusive === (g.groups[x].hasExclusive || g.groups[x].isExclusive))
    await this.__runGroup(g.groups[x], stats)
  }
  if (g.after) {
    await this.__runTest(stats, g.after, 'After')
  }
}

Eltro.prototype.run = async function() {
  if (this.reporter) {
    console.log('')
    console.log('')
  }

  let stats = {
    passed: 0,
    failed: 0,
    skipped: 0,
  }

  let start = process.hrtime()
  for (let i = 0; i < this.groups.length; i++) {
    if (!this.groups[i].skipTest && this.hasExclusive === (this.groups[i].hasExclusive || this.groups[i].isExclusive)) {
      await this.__runGroup(this.groups[i], stats)
    }
  }

  let end = process.hrtime(start)

  if (this.reporter) {
    console.log('')
    console.log('')
    if (stats.passed) {
      console.log('  \x1b[32m' + stats.passed + ' passing \x1b[90m(' + (end[0] * 1000 + Math.round(end[1] / 1000000)) + 'ms)\x1b[0m')
    }
    if (stats.failed) {
      console.log('  \x1b[31m' + stats.failed + ' failing\x1b[0m')
    }
    if (stats.skipped) {
      console.log('  \x1b[94m' + stats.skipped + ' pending\x1b[0m')
    }
    console.log('')

    if (this.failedTests.length) {
      for (let x = 0; x < this.failedTests.length; x++) {
        let test = this.failedTests[x];
        console.log('  ' + (x + 1) + ') ' + test.name + ':')
        printError(test.error)
      }
    }
  }
  return stats
}

Eltro.prototype.setFilename = function(filename) {
  if (!this.fileGroupMap.has(filename)) {
    let g = new Group(this, filename + ':')
    this.groups.push(g)
    this.fileGroupMap.set(filename, g)
  }
  this.activeGroup = this.fileGroupMap.get(filename)
}

Eltro.prototype.resetFilename = function() {
  this.activeGroup = null
}

Eltro.prototype.before = function(func) {
  if (!this.activeGroup) {
    throw new Error('Tests outside groups are not allowed.')
  }

  let test = new Test(this, this.activeGroup, 'Before: ' + this.activeGroup.name, func)

  if (this.temporary.timeout || this.activeGroup.customTimeout) {
    test.timeout(this.temporary.timeout || this.activeGroup.customTimeout)
    this.temporary.timeout = 0
  }
  
  this.activeGroup.before = test
  return test
}

Eltro.prototype.after = function(func) {
  if (!this.activeGroup) {
    throw new Error('Tests outside groups are not allowed.')
  }

  let test = new Test(this, this.activeGroup, 'After: ' + this.activeGroup.name, func)

  if (this.temporary.timeout || this.activeGroup.customTimeout) {
    test.timeout(this.temporary.timeout || this.activeGroup.customTimeout)
    this.temporary.timeout = 0
  }
  
  this.activeGroup.after = test
  return test
}

Eltro.prototype.describe = function(name, func) {
  let before = this.activeGroup

  let prefix = before ? before.name + ' ' : ''

  this.activeGroup = new Group(this, prefix + name)

  if (before) {
    before.groups.push(this.activeGroup)
    this.activeGroup.parent = before
    this.activeGroup.customTimeout = before.customTimeout
  } else {
    this.groups.push(this.activeGroup)
  }

  if (this.temporary.timeout) {
    this.activeGroup.timeout(this.temporary.timeout)
    this.temporary.timeout = 0
  }
  if (this.temporary.skip) {
    this.activeGroup.skip()
    this.temporary.skip = false
  }
  if (this.temporary.only) {
    this.activeGroup.only()
    this.temporary.only = false
  }

  func()

  this.activeGroup = before
}

Eltro.prototype.timeout = function(time) {
  this.temporary.timeout = time
  return this
}

Eltro.prototype.skip = function() {
  this.temporary.skip = true
  return this
}

Eltro.prototype.only = function() {
  this.temporary.only = true
  return this
}

Eltro.prototype.test = function(name, func) {
  if (!this.activeGroup) {
    throw new Error('Tests outside groups are not allowed.')
  }

  let test = new Test(this, this.activeGroup, this.activeGroup.name + ' ' + name, func)
  this.activeGroup.tests.push(test)

  if (this.temporary.only && !this.temporary.skip) {
    test.only()
    this.temporary.only = false
  } else if (this.temporary.only) {
    this.temporary.only = false
  }
  if (this.temporary.skip) {
    test.skip()
    this.temporary.skip = false
  }
  if (this.temporary.timeout || this.activeGroup.customTimeout) {
    test.timeout(this.temporary.timeout || this.activeGroup.customTimeout)
    this.temporary.timeout = 0
  }
  return test
}

export default new Eltro()
