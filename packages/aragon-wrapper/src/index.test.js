import test from 'ava'
import sinon from 'sinon'
import proxyquire from 'proxyquire'
import { of, from } from 'rxjs'
import { first } from 'rxjs/operators'
import AsyncRequestCache from './utils/AsyncRequestCache'

test.beforeEach(t => {
  const apmStub = sinon.stub()
  const aragonOSCoreStub = {
    getAragonOsInternalAppInfo: sinon.stub()
  }
  const messengerConstructorStub = sinon.stub()
  const utilsStub = {
    AsyncRequestCache,
    makeAddressMapProxy: sinon.fake.returns({}),
    makeProxy: sinon.stub(),
    addressesEqual: Object.is
  }
  const Aragon = proxyquire.noCallThru().load('./index', {
    '@aragon/apm': sinon.stub().returns(apmStub),
    '@aragon/rpc-messenger': messengerConstructorStub,
    './core/aragonOS': aragonOSCoreStub,
    './utils': utilsStub
  }).default

  t.context = {
    Aragon,
    apmStub,
    aragonOSCoreStub,
    messengerConstructorStub,
    utilsStub
  }
})

test.afterEach.always(() => {
  sinon.restore()
})

test('should create an Aragon instance with no options given', t => {
  const { Aragon } = t.context

  t.plan(1)
  // act
  const app = new Aragon(0x0)
  // assert
  t.not(app.apm, undefined)
})

test('should throw on init if daoAddress is not a Kernel', async (t) => {
  const { Aragon } = t.context

  t.plan(1)
  // arrange
  const badDaoAddress = '0xbaddao'
  const instance = new Aragon(badDaoAddress)
  // web3 will throw if a bad address ('0x') comes back
  const kernelProxyCallStub = sinon.stub().withArgs('acl').throws()
  instance.kernelProxy = {
    address: badDaoAddress,
    call: kernelProxyCallStub
  }

  // act and assert
  await t.throwsAsync(
    instance.init(),
    {
      instanceOf: Error,
      message: `Provided daoAddress is not a DAO`
    }
  )
})

test('should use provided accounts', async (t) => {
  const { Aragon } = t.context

  t.plan(1)
  // arrange
  const instance = new Aragon()
  // act
  await instance.initAccounts({ providedAccounts: ['0x00'] })
  const accounts = await instance.getAccounts()
  // assert
  t.deepEqual(accounts, ['0x00'])
})

test('should get the accounts from web3', async (t) => {
  const { Aragon } = t.context

  t.plan(1)
  // arrange
  const instance = new Aragon()
  instance.web3 = {
    eth: {
      getAccounts: sinon.stub().resolves(['0x01', '0x02'])
    }
  }
  // act
  await instance.initAccounts({ fetchFromWeb3: true })
  const accounts = await instance.getAccounts()
  // assert
  t.deepEqual(accounts, ['0x01', '0x02'])
})

test('should not fetch the accounts if not asked', async (t) => {
  const { Aragon } = t.context

  t.plan(1)
  // arrange
  const instance = new Aragon()
  instance.web3 = {
    eth: {
      getAccounts: sinon.stub().resolves(['0x01', '0x02'])
    }
  }
  // act
  await instance.initAccounts({ fetchFromWeb3: false })
  const accounts = await instance.getAccounts()
  // assert
  t.deepEqual(accounts, [])
})

test('should get the network details from web3', async (t) => {
  const { Aragon } = t.context

  t.plan(1)
  // arrange
  const instance = new Aragon()
  const testNetworkId = 4
  const testNetworkType = 'rinkeby'
  instance.web3 = {
    eth: {
      net: {
        getId: sinon.stub().resolves(testNetworkId),
        getNetworkType: sinon.stub().resolves(testNetworkType)
      }
    }
  }
  // act
  await instance.initNetwork()
  // assert
  instance.network.subscribe(network => {
    t.deepEqual(network, {
      id: testNetworkId,
      type: testNetworkType
    })
  })
})

test('should init the ACL correctly', async (t) => {
  const { Aragon, utilsStub } = t.context

  t.plan(1)
  // arrange
  const setPermissionEvents = from([{
    event: 'SetPermission',
    returnValues: {
      app: 'counter',
      role: 'add',
      allowed: true,
      entity: '0x1'
    }
  }, {
    event: 'SetPermission',
    returnValues: {
      app: 'counter',
      role: 'subtract',
      allowed: true,
      entity: '0x1'
    }
  }, {
    event: 'SetPermission',
    returnValues: {
      app: 'counter',
      role: 'add',
      allowed: true,
      entity: '0x2'
    }
  }, {
    event: 'SetPermission',
    returnValues: {
      app: 'counter',
      role: 'subtract',
      allowed: true,
      entity: '0x2'
    }
  }, {
    event: 'SetPermission',
    returnValues: {
      app: 'counter',
      role: 'subtract',
      allowed: false,
      entity: '0x2'
    }
  }, {
    // duplicate, should not affect the final result because we use a Set
    event: 'SetPermission',
    returnValues: {
      app: 'counter',
      role: 'subtract',
      allowed: false,
      entity: '0x2'
    }
  }])
  const changePermissionManagerEvents = of({
    event: 'ChangePermissionManager',
    returnValues: {
      app: 'counter',
      role: 'subtract',
      manager: 'manager'
    }
  })
  const instance = new Aragon()
  instance.kernelProxy = {
    call: sinon.stub()
  }
  const aclProxyStub = {
    events: sinon.stub()
  }
  aclProxyStub.events.withArgs('SetPermission').returns(setPermissionEvents)
  aclProxyStub.events.withArgs('ChangePermissionManager').returns(changePermissionManagerEvents)
  utilsStub.makeProxy.returns(aclProxyStub)
  // act
  await instance.initAcl()
  // assert, tell ava to wait for the permissions observable to debounce
  return new Promise(resolve => {
    instance.permissions.subscribe(value => {
      t.deepEqual(value, {
        counter: {
          add: {
            allowedEntities: ['0x1', '0x2']
          },
          subtract: {
            allowedEntities: ['0x1'],
            manager: 'manager'
          }
        }
      })
      // The permissions observable debounces, so we should only get one value back
      setTimeout(resolve, 2000)
    })
  })
})

test('should init the acl with the default acl fetched from the kernel by default', async (t) => {
  const { Aragon, utilsStub } = t.context

  t.plan(2)
  // arrange
  const defaultAclAddress = '0x321'
  const aclProxyStub = {
    events: sinon.stub()
  }
  const kernelProxyStub = {
    call: sinon.stub()
      .withArgs('acl').resolves(defaultAclAddress)
  }
  utilsStub.makeProxy
    .returns(kernelProxyStub)
    .withArgs(defaultAclAddress).returns(aclProxyStub)

  const instance = new Aragon()

  // act
  await instance.initAcl()
  // assert
  t.truthy(kernelProxyStub.call.calledOnceWith('acl'))
  t.truthy(utilsStub.makeProxy.calledWith(defaultAclAddress))
})

test('should init the acl with the provided acl', async (t) => {
  const { Aragon, utilsStub } = t.context

  t.plan(3)
  // arrange
  const defaultAclAddress = '0x321'
  const givenAclAddress = '0x123'
  const aclProxyStub = {
    events: sinon.stub()
  }
  const kernelProxyStub = {
    call: sinon.stub()
      .withArgs('acl').resolves(defaultAclAddress)
  }
  utilsStub.makeProxy
    .returns(kernelProxyStub)
    .withArgs(givenAclAddress).returns(aclProxyStub)

  const instance = new Aragon()

  // act
  await instance.initAcl({ aclAddress: givenAclAddress })
  // assert
  t.truthy(kernelProxyStub.call.notCalled)
  t.truthy(utilsStub.makeProxy.neverCalledWith(defaultAclAddress))
  t.truthy(utilsStub.makeProxy.calledWith(givenAclAddress))
})

const kernelAddress = '0x123'
const appInitTestCases = [
  [
    'with kernel in permissions',
    {
      [kernelAddress]: 'some permissions',
      '0x456': 'some permissions',
      '0x789': 'some permissions'
    }
  ],
  [
    'without kernel in permissions',
    {
      '0x456': 'some permissions',
      '0x789': 'some permissions'
    }
  ]
]
appInitTestCases.forEach(([testName, permissionsObj]) => {
  test(`should init the apps correctly - ${testName}`, async (t) => {
    const { Aragon, apmStub, aragonOSCoreStub, utilsStub } = t.context

    t.plan(2)
    // arrange
    const kernelAddress = '0x123'
    const appIds = {
      [kernelAddress]: 'kernel',
      '0x456': 'counterApp',
      '0x789': 'votingApp'
    }
    const codeAddresses = {
      [kernelAddress]: '0xkernel',
      '0x456': '0xcounterApp',
      '0x789': '0xvotingApp'
    }
    // Stub makeProxy for each app
    Object.keys(appIds).forEach(address => {
      const proxyStub = {
        call: sinon.stub()
      }
      proxyStub.call
        .withArgs('kernel').resolves(kernelAddress)
        .withArgs('appId').resolves(appIds[address])
        .withArgs('implementation').resolves(codeAddresses[address])
        .withArgs('isForwarder').resolves(false)

      utilsStub.makeProxy
        .withArgs(address).returns(proxyStub)
    })
    apmStub.getLatestVersionForContract = (appId) => Promise.resolve({
      abi: `abi for ${appId}`
    })
    aragonOSCoreStub.getAragonOsInternalAppInfo.withArgs(appIds[kernelAddress]).returns({
      abi: 'abi for kernel',
      isAragonOsInternalApp: true
    })

    const instance = new Aragon()
    instance.permissions = of(permissionsObj)
    instance.kernelProxy = {
      address: kernelAddress,
      call: sinon.stub().withArgs('KERNEL_APP_ID').resolves('kernel')
    }
    // act
    await instance.initApps()
    // assert

    // Check initial value of apps
    instance.apps.pipe(first()).subscribe(value => {
      t.deepEqual(value, [
        {
          abi: 'abi for kernel',
          appId: 'kernel',
          codeAddress: '0xkernel',
          isAragonOsInternalApp: true,
          proxyAddress: '0x123'
        }, {
          abi: 'abi for counterApp',
          appId: 'counterApp',
          codeAddress: '0xcounterApp',
          isForwarder: false,
          kernelAddress: '0x123',
          proxyAddress: '0x456'
        }, {
          abi: 'abi for votingApp',
          appId: 'votingApp',
          codeAddress: '0xvotingApp',
          isForwarder: false,
          kernelAddress: '0x123',
          proxyAddress: '0x789'
        }
      ])
    })

    // hack: wait 200ms for the subscribe callback above to be called,
    // otherwise it will emit with the identifier set below
    await new Promise(resolve => setTimeout(resolve, 200))

    // act
    await instance.setAppIdentifier('0x456', 'CNT')
    // assert
    instance.apps.subscribe(value => {
      t.deepEqual(value, [
        {
          abi: 'abi for kernel',
          appId: 'kernel',
          codeAddress: '0xkernel',
          isAragonOsInternalApp: true,
          proxyAddress: '0x123'
        }, {
          abi: 'abi for counterApp',
          appId: 'counterApp',
          codeAddress: '0xcounterApp',
          isForwarder: false,
          kernelAddress: '0x123',
          proxyAddress: '0x456',
          identifier: 'CNT'
        }, {
          abi: 'abi for votingApp',
          appId: 'votingApp',
          codeAddress: '0xvotingApp',
          isForwarder: false,
          kernelAddress: '0x123',
          proxyAddress: '0x789'
        }
      ])
    })
  })
})

test('should init the identity providers correctly', async (t) => {
  const { Aragon } = t.context

  t.plan(3)
  // arrange
  const instance = new Aragon()

  // act
  await instance.initIdentityProviders()
  // assert
  t.truthy(instance.identityProviderRegistrar)
  t.true(instance.identityProviderRegistrar instanceof Map)
  t.is(instance.identityProviderRegistrar.size, 1, 'Should have only one provider')
})

test('should emit an intent when requesting address identity modification', async (t) => {
  const { Aragon } = t.context

  t.plan(2)
  // arrange
  const instance = new Aragon()

  // act
  await instance.initIdentityProviders()

  const expectedAddress = '0x123'

  instance.identityIntents.subscribe(intent => {
    t.is(intent.address, expectedAddress)
    t.is(intent.providerName, 'local')
  })

  instance.requestAddressIdentityModification(expectedAddress)
})

test('should init the forwarders correctly', async (t) => {
  const { Aragon } = t.context

  t.plan(1)
  // arrange
  const instance = new Aragon()
  instance.apps = of([
    {
      appId: 'counterApp',
      isForwarder: true
    }, {
      appId: 'votingApp',
      isForwarder: false
    }
  ])
  // act
  await instance.initForwarders()
  // assert
  instance.forwarders.subscribe(value => {
    t.deepEqual(value, [
      {
        appId: 'counterApp',
        isForwarder: true
      }
    ])
  })
})

test('should init the notifications correctly', async (t) => {
  const { Aragon } = t.context

  t.plan(7)
  // arrange
  const instance = new Aragon()
  instance.cache.get = sinon.stub()
    .withArgs('notifications').returns([
      {
        read: true,
        title: 'send'
      }, {
        read: false,
        title: 'receive'
      }
    ])
  instance.cache.set = sinon.stub()
  // act
  await instance.initNotifications()
  // assert
  instance.notifications.subscribe(value => {
    t.is(value[0].read, true)
    t.is(value[0].title, 'send')

    t.is(value[1].read, false)
    t.is(value[1].title, 'receive')
    // only the receive notification should get an acknowledge fn attached
    t.is('acknowledge' in value[1], true)
  })

  t.is(instance.cache.set.getCall(0).args[0], 'notifications')
  t.is(instance.cache.set.getCall(0).args[1].length, 2)
})

test('should send notifications correctly', async (t) => {
  const { Aragon } = t.context

  t.plan(12)
  // arrange
  const instance = new Aragon()
  await instance.cache.init()
  await instance.initNotifications()
  // act
  await instance.sendNotification('counterApp', 'add')
  await instance.sendNotification('counterApp', 'subtract', null, null, new Date(2))

  // assert
  instance.notifications.subscribe(value => {
    t.is(value[0].app, 'counterApp')
    t.is(value[0].title, 'subtract')
    t.is(value[0].read, false)
    t.is(value[0].body, null)
    t.is(value[0].context, null)
    // uuidv4
    t.is(value[0].id.length, 36)

    t.is(value[1].app, 'counterApp')
    t.is(value[1].title, 'add')
    t.is(value[1].read, false)
    t.is(value[1].body, undefined)
    t.deepEqual(value[1].context, {})
    t.is(value[1].id.length, 36)
  })
})

test('should run the app and reply to a request', async (t) => {
  const { Aragon, messengerConstructorStub, utilsStub } = t.context

  // Note: This is not a "real" unit test because the rpc handlers are not mocked
  t.plan(4)
  // arrange
  const requestsStub = of({
    id: 'uuid1',
    method: 'cache',
    params: ['get', 'settings']
  })
  const messengerStub = {
    sendResponse: sinon.stub(),
    requests: () => requestsStub
  }
  messengerConstructorStub.withArgs('someMessageProvider').returns(messengerStub)
  const instance = new Aragon()
  instance.cache.observe = sinon.stub()
    .withArgs('0x789.settings')
    .returns(of('user settings for the voting app'))
  instance.apps = of([
    {
      appId: 'some other app with a different proxy',
      proxyAddress: '0x456'
    }, {
      appId: 'votingApp',
      kernelAddress: '0x123',
      abi: 'abi for votingApp',
      proxyAddress: '0x789'
    }
  ])
  utilsStub.makeProxyFromABI = (proxyAddress) => ({
    address: proxyAddress,
    updateInitializationBlock: () => {}
  })
  instance.kernelProxy = { initializationBlock: 0 }
  // act
  const connect = await instance.runApp('0x789')
  const result = connect('someMessageProvider')
  // assert
  t.true(result.shutdown !== undefined)
  t.true(result.setContext !== undefined)
  /**
   * What we're testing here is that the request for getting the cache (messenger.requests())
   * is handled by the appropriate requestHandler.
   */
  t.is(messengerStub.sendResponse.getCall(0).args[0], 'uuid1')
  t.is(messengerStub.sendResponse.getCall(0).args[1], 'user settings for the voting app')
})

test('should get the app from a proxy address', async (t) => {
  const { Aragon } = t.context

  t.plan(1)
  // arrange
  const instance = new Aragon()
  instance.apps = of([
    {
      appId: 'some other app with a different proxy',
      proxyAddress: '0x456'
    }, {
      appId: 'votingApp',
      kernelAddress: '0x123',
      abi: 'abi for votingApp',
      proxyAddress: '0x789'
    }
  ])
  // act
  const result = await instance.getApp('0x789')
  // assert
  t.deepEqual(result, {
    appId: 'votingApp',
    kernelAddress: '0x123',
    abi: 'abi for votingApp',
    proxyAddress: '0x789'
  })
})

test('should get the permission manager', async (t) => {
  const { Aragon } = t.context

  t.plan(1)
  // arrange
  const instance = new Aragon()
  instance.permissions = of({
    counter: {
      add: {
        allowedEntities: ['0x1', '0x2']
      },
      subtract: {
        allowedEntities: ['0x1'],
        manager: 'im manager'
      }
    }
  })
  // act
  const result = await instance.getPermissionManager('counter', 'subtract')
  // assert
  t.is(result, 'im manager')
})

test('should throw if no ABI is found, when calculating the transaction path', async (t) => {
  const { Aragon } = t.context

  t.plan(1)
  // arrange
  const instance = new Aragon()
  instance.permissions = of({
    counter: {
      add: {
        allowedEntities: ['0x1', '0x2']
      },
      subtract: {
        allowedEntities: ['0x1'],
        manager: 'im manager'
      }
    }
  })
  instance.forwarders = of([
    {
      appId: 'forwarderA',
      proxyAddress: '0x999'
    }
  ])
  instance.apps = of([
    {
      appId: 'counterApp',
      kernelAddress: '0x123',
      abi: 'abi for counterApp',
      proxyAddress: '0x456'
    }, {
      appId: 'votingApp',
      kernelAddress: '0x123',
      // abi: 'abi for votingApp',
      proxyAddress: '0x789'
    }
  ])
  // act
  return instance.calculateTransactionPath(null, '0x789')
    .catch(err => {
      // assert
      t.is(err.message, 'No ABI specified in artifact for 0x789')
      /*
       * Note: This test also "asserts" that the permissions object, the app object and the
       * forwarders array does not throw any errors when they are being extracted from their observables.
       */
    })
})
