import { BigInt, BigDecimal, Address, Bytes, ByteArray, log, store, dataSource } from '@graphprotocol/graph-ts'
import { LOG_CALL, LOG_JOIN, LOG_EXIT, LOG_SWAP, Transfer } from '../types/templates/Pool/Pool'
import { BToken } from '../types/templates/Pool/BToken'
import { BTokenBytes } from '../types/templates/Pool/BTokenBytes'
import {
  Balancer,
  Pool,
  User,
  PoolToken,
  PoolShare,
  Transaction,
  Swap,
  TokenPrice
} from '../types/schema'

let network = dataSource.network()
let WETH: string;
let USD: string;
if (network == 'mainnet') {
  WETH = '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2'
  USD = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48' // USDC
} else if (network == 'kovan') {
  WETH = '0xd0a1e359811322d97991e03f863a0c30c2cf029c'
  USD = '0x1528f3fcc26d13f7079325fb78d9442607781c8c' // DAI
}

/************************************
 ********** Helpers ***********
 ************************************/

function hexToDecimal(hexString: String, decimals: i32): BigDecimal {
  let bytes = Bytes.fromHexString(hexString).reverse() as Bytes
  let bi = BigInt.fromUnsignedBytes(bytes)
  let scale = BigInt.fromI32(10).pow(decimals as u8).toBigDecimal()
  return bi.divDecimal(scale)
}

function bigIntToDecimal(amount: BigInt, decimals: i32): BigDecimal {
  let scale = BigInt.fromI32(10).pow(decimals as u8).toBigDecimal()
  return amount.toBigDecimal().div(scale)
}

function tokenToDecimal(amount: BigDecimal, decimals: i32): BigDecimal {
  let scale = BigInt.fromI32(10).pow(decimals as u8).toBigDecimal()
  return amount.div(scale)
}

function createPoolShareEntity(id: string, pool: String, user: String): void {

  let poolShare = new PoolShare(id)

  let userdb = User.load(user)
  if (userdb == null) {
    userdb = new User(user)
    userdb.save()
  }
  poolShare.userAddress = user
  poolShare.poolId = pool
  poolShare.balance = BigDecimal.fromString('0')
  poolShare.save()
}

function createPoolTokenEntity(id: string, pool: String, address: String): void {
  let token = BToken.bind(Address.fromString(address))
  let tokenBytes = BTokenBytes.bind(Address.fromString(address))
  let symbol = ''
  let name = ''
  let decimals = 18

  // COMMENT THE LINES BELOW OUT FOR LOCAL DEV ON KOVAN

  let symbolCall = token.try_symbol()
  let nameCall = token.try_name()
  let decimalCall = token.try_decimals()

  if (symbolCall.reverted) {
    let symbolBytesCall = tokenBytes.try_symbol()
    if (!symbolBytesCall.reverted) {
      symbol = symbolBytesCall.value.toString()
    }
  } else {
    symbol = symbolCall.value
  }

  if (nameCall.reverted) {
    let nameBytesCall = tokenBytes.try_name()
    if (!nameBytesCall.reverted) {
      name = nameBytesCall.value.toString()
    }
  } else {
    name = nameCall.value
  }

  if (!decimalCall.reverted) {
    decimals = decimalCall.value
  }

  // COMMENT THE LINES ABOVE OUT FOR LOCAL DEV ON KOVAN

  // !!! COMMENT THE LINES BELOW OUT FOR NON-LOCAL DEPLOYMENT
  // This code allows Symbols to be added when testing on local Kovan
  /*
  if(address == '0xd0a1e359811322d97991e03f863a0c30c2cf029c')
    symbol = 'WETH';
  else if(address == '0x1528f3fcc26d13f7079325fb78d9442607781c8c')
    symbol = 'DAI'
  else if(address == '0xef13c0c8abcaf5767160018d268f9697ae4f5375')
    symbol = 'MKR'
  else if(address == '0x2f375e94fc336cdec2dc0ccb5277fe59cbf1cae5')
    symbol = 'USDC'
  else if(address == '0x1f1f156e0317167c11aa412e3d1435ea29dc3cce')
    symbol = 'BAT'
  else if(address == '0x86436bce20258a6dcfe48c9512d4d49a30c4d8c4')
    symbol = 'SNX'
  else if(address == '0x8c9e6c40d3402480ace624730524facc5482798c')
    symbol = 'REP'
  */
  // !!! COMMENT THE LINES ABOVE OUT FOR NON-LOCAL DEPLOYMENT

  let poolToken = new PoolToken(id)
  poolToken.poolId = pool
  poolToken.address = address
  poolToken.name = name
  poolToken.symbol = symbol
  poolToken.decimals = decimals
  poolToken.balance = BigDecimal.fromString('0')
  poolToken.denormWeight = BigDecimal.fromString('0')
  poolToken.save()
}

function updatePoolLiquidity(id: string): void {
  let pool = Pool.load(id)
  let tokensList: Array<Bytes> = pool.tokensList

  if (!tokensList || !pool.publicSwap) return

  /* Create or update token price */

  if (tokensList.includes(Address.fromString(USD))) {
    let usdPoolTokenId = id.concat('-').concat(USD)
    let usdPoolToken = PoolToken.load(usdPoolTokenId)
    let poolLiquidity = usdPoolToken.balance.div(usdPoolToken.denormWeight).times(pool.totalWeight)

    for (let i: i32 = 0; i < tokensList.length; i++) {
      let tokenPriceId = tokensList[i].toHexString()
      let tokenPrice = TokenPrice.load(tokenPriceId)
      if (tokenPrice == null) {
        tokenPrice = new TokenPrice(tokenPriceId)
        tokenPrice.poolTokenId = ''
        tokenPrice.poolLiquidity = BigDecimal.fromString('0')
      }

      let poolTokenId = id.concat('-').concat(tokenPriceId)
      let poolToken = PoolToken.load(poolTokenId)

      if (tokenPrice.poolTokenId == poolTokenId || poolLiquidity.gt(tokenPrice.poolLiquidity)) {
        tokenPrice.price = BigDecimal.fromString('0')

        if (poolToken.balance.gt(BigDecimal.fromString('0'))) {
          tokenPrice.price = poolLiquidity.div(pool.totalWeight).times(poolToken.denormWeight).div(poolToken.balance)
        }

        tokenPrice.symbol = poolToken.symbol
        tokenPrice.poolLiquidity = poolLiquidity
        tokenPrice.poolTokenId = poolTokenId
        tokenPrice.save()
      }
    }
  }

  /* Update pool liquidity */

  let liquidity = BigDecimal.fromString('0')
  let denormWeight = BigDecimal.fromString('0')

  for (let i: i32 = 0; i < tokensList.length; i++) {
    let tokenPriceId = tokensList[i].toHexString()
    let tokenPrice = TokenPrice.load(tokenPriceId)
    if (tokenPrice !== null) {
      let poolTokenId = id.concat('-').concat(tokenPriceId)
      let poolToken = PoolToken.load(poolTokenId)

      if (poolToken.denormWeight.gt(denormWeight)) {
        denormWeight = poolToken.denormWeight
        liquidity = tokenPrice.price.times(poolToken.balance).div(poolToken.denormWeight).times(pool.totalWeight)
      }
    }
  }

  pool.liquidity = liquidity
  pool.save()
}

/************************************
 ********** Pool Controls ***********
 ************************************/

export function handleSetSwapFee(event: LOG_CALL): void {
  let poolId = event.address.toHex()
  let pool = Pool.load(poolId)
  let swapFee = hexToDecimal(event.params.data.toHexString().slice(-40), 18)
  pool.swapFee = swapFee
  pool.save()

  let tx = event.transaction.hash.toHexString().concat('-').concat(event.logIndex.toString())
  let transaction = Transaction.load(tx)
  if (transaction == null) {
    transaction = new Transaction(tx)
  }
  transaction.event = 'setSwapFee'
  transaction.poolAddress = event.address.toHex()
  transaction.userAddress = event.transaction.from.toHex()
  transaction.gasUsed = event.transaction.gasUsed.toBigDecimal()
  transaction.gasPrice = event.transaction.gasPrice.toBigDecimal()
  transaction.tx = event.transaction.hash
  transaction.timestamp = event.block.timestamp.toI32()
  transaction.block = event.block.number.toI32()
  transaction.save()
}

export function handleSetController(event: LOG_CALL): void {
  let poolId = event.address.toHex()
  let pool = Pool.load(poolId)
  let controller = Address.fromString(event.params.data.toHexString().slice(-40))
  pool.controller = controller
  pool.save()

  let tx = event.transaction.hash.toHexString().concat('-').concat(event.logIndex.toString())
  let transaction = Transaction.load(tx)
  if (transaction == null) {
    transaction = new Transaction(tx)
  }
  transaction.event = 'setController'
  transaction.poolAddress = event.address.toHex()
  transaction.userAddress = event.transaction.from.toHex()
  transaction.gasUsed = event.transaction.gasUsed.toBigDecimal()
  transaction.gasPrice = event.transaction.gasPrice.toBigDecimal()
  transaction.tx = event.transaction.hash
  transaction.timestamp = event.block.timestamp.toI32()
  transaction.block = event.block.number.toI32()
  transaction.save()
}

export function handleSetPublicSwap(event: LOG_CALL): void {
  let poolId = event.address.toHex()
  let pool = Pool.load(poolId)
  let publicSwap = event.params.data.toHexString().slice(-1) == '1'
  pool.publicSwap = publicSwap
  pool.save()

  let tx = event.transaction.hash.toHexString().concat('-').concat(event.logIndex.toString())
  let transaction = Transaction.load(tx)
  if (transaction == null) {
    transaction = new Transaction(tx)
  }
  transaction.event = 'setPublicSwap'
  transaction.poolAddress = event.address.toHex()
  transaction.userAddress = event.transaction.from.toHex()
  transaction.gasUsed = event.transaction.gasUsed.toBigDecimal()
  transaction.gasPrice = event.transaction.gasPrice.toBigDecimal()
  transaction.tx = event.transaction.hash
  transaction.timestamp = event.block.timestamp.toI32()
  transaction.block = event.block.number.toI32()
  transaction.save()
}

export function handleFinalize(event: LOG_CALL): void {
  let poolId = event.address.toHex()
  let pool = Pool.load(poolId)
  // let balance = BigDecimal.fromString('100')
  pool.finalized = true
  pool.publicSwap = true
  // pool.totalShares = balance
  pool.save()

  let userId = event.params.caller.toHex()
  let user = User.load(userId)
  if (user == null) {
    user = new User(userId)
    user.save()
  }
  /*
  let poolShareId = poolId.concat('-').concat(event.params.caller.toHex())
  let poolShare = PoolShare.load(poolShareId)
  if (poolShare == null) {
    createPoolShareEntity(poolShareId, poolId, event.params.caller.toHex())
    poolShare = PoolShare.load(poolShareId)
  }
  poolShare.balance = balance
  poolShare.save()
  */

  let factory = Balancer.load('1')
  factory.finalizedPoolCount = factory.finalizedPoolCount + 1
  factory.save()

  let tx = event.transaction.hash.toHexString().concat('-').concat(event.logIndex.toString())
  let transaction = Transaction.load(tx)
  if (transaction == null) {
    transaction = new Transaction(tx)
  }
  transaction.event = 'finalize'
  transaction.poolAddress = event.address.toHex()
  transaction.userAddress = event.transaction.from.toHex()
  transaction.gasUsed = event.transaction.gasUsed.toBigDecimal()
  transaction.gasPrice = event.transaction.gasPrice.toBigDecimal()
  transaction.tx = event.transaction.hash
  transaction.timestamp = event.block.timestamp.toI32()
  transaction.block = event.block.number.toI32()
  transaction.save()
}

export function handleRebind(event: LOG_CALL): void {
  let poolId = event.address.toHex()
  let pool = Pool.load(poolId)
  let tokenBytes = Bytes.fromHexString(event.params.data.toHexString().slice(34,74)) as Bytes
  let tokensList = pool.tokensList || []
  if (tokensList.indexOf(tokenBytes) == -1 ) {
    tokensList.push(tokenBytes)
  }
  pool.tokensList = tokensList


  let address = Address.fromString(event.params.data.toHexString().slice(34,74))
  let denormWeight = hexToDecimal(event.params.data.toHexString().slice(138), 18)

  let poolTokenId = poolId.concat('-').concat(address.toHexString())
  let poolToken = PoolToken.load(poolTokenId)
  if (poolToken == null) {
    createPoolTokenEntity(poolTokenId, poolId, address.toHexString())
    poolToken = PoolToken.load(poolTokenId)
    pool.totalWeight += denormWeight
  } else {
    let oldWeight = poolToken.denormWeight
    if (denormWeight > oldWeight) {
      pool.totalWeight = pool.totalWeight + (denormWeight - oldWeight);
    } else {
      pool.totalWeight = pool.totalWeight - (oldWeight - denormWeight);
    }
  }

  let balance = hexToDecimal(event.params.data.toHexString().slice(74,138), poolToken.decimals)

  poolToken.balance = balance
  poolToken.denormWeight = denormWeight
  poolToken.save()
  pool.save()

  updatePoolLiquidity(poolId)

  let tx = event.transaction.hash.toHexString().concat('-').concat(event.logIndex.toString())
  let transaction = Transaction.load(tx)
  if (transaction == null) {
    transaction = new Transaction(tx)
  }
  transaction.event = 'rebind'
  transaction.poolAddress = event.address.toHex()
  transaction.userAddress = event.transaction.from.toHex()
  transaction.gasUsed = event.transaction.gasUsed.toBigDecimal()
  transaction.gasPrice = event.transaction.gasPrice.toBigDecimal()
  transaction.tx = event.transaction.hash
  transaction.timestamp = event.block.timestamp.toI32()
  transaction.block = event.block.number.toI32()
  transaction.save()
}

export function handleUnbind(event: LOG_CALL): void {
  let poolId = event.address.toHex()
  let pool = Pool.load(poolId)
  let tokenBytes = Bytes.fromHexString(event.params.data.toHexString().slice(-40)) as Bytes
  let tokensList = pool.tokensList || []
  let index = tokensList.indexOf(tokenBytes)
  tokensList.splice(index, 1)
  pool.tokensList = tokensList


  let address = Address.fromString(event.params.data.toHexString().slice(-40))
  let poolTokenId = poolId.concat('-').concat(address.toHexString())
  let poolToken = PoolToken.load(poolTokenId)
  pool.totalWeight -= poolToken.denormWeight
  pool.save()
  store.remove('PoolToken', poolTokenId)

  let tx = event.transaction.hash.toHexString().concat('-').concat(event.logIndex.toString())
  let transaction = Transaction.load(tx)
  if (transaction == null) {
    transaction = new Transaction(tx)
  }
  transaction.event = 'unbind'
  transaction.poolAddress = event.address.toHex()
  transaction.userAddress = event.transaction.from.toHex()
  transaction.gasUsed = event.transaction.gasUsed.toBigDecimal()
  transaction.gasPrice = event.transaction.gasPrice.toBigDecimal()
  transaction.tx = event.transaction.hash
  transaction.timestamp = event.block.timestamp.toI32()
  transaction.block = event.block.number.toI32()
  transaction.save()
}

export function handleGulp(event: LOG_CALL): void {
  let poolId = event.address.toHex()
  let pool = Pool.load(poolId)

  let address = Address.fromString(event.params.data.toHexString().slice(-40))

  let token = BToken.bind(address)
  let balanceCall = token.try_balanceOf(Address.fromString(poolId))

  let poolTokenId = poolId.concat('-').concat(address.toHexString())
  let poolToken = PoolToken.load(poolTokenId)

  let balance = poolToken.balance
  if (!balanceCall.reverted) {
    balance = bigIntToDecimal(balanceCall.value, poolToken.decimals)
  }
  poolToken.balance = balance
  poolToken.save()

  updatePoolLiquidity(poolId)

  let tx = event.transaction.hash.toHexString().concat('-').concat(event.logIndex.toString())
  let transaction = Transaction.load(tx)
  if (transaction == null) {
    transaction = new Transaction(tx)
  }
  transaction.event = 'gulp'
  transaction.poolAddress = event.address.toHex()
  transaction.userAddress = event.transaction.from.toHex()
  transaction.gasUsed = event.transaction.gasUsed.toBigDecimal()
  transaction.gasPrice = event.transaction.gasPrice.toBigDecimal()
  transaction.tx = event.transaction.hash
  transaction.timestamp = event.block.timestamp.toI32()
  transaction.block = event.block.number.toI32()
  transaction.save()
}

/************************************
 ********** JOINS & EXITS ***********
 ************************************/

export function handleJoinPool(event: LOG_JOIN): void {
  let poolId = event.address.toHex()
  let pool = Pool.load(poolId)
  pool.joinsCount += BigInt.fromI32(1)
  pool.save()

  let address = event.params.tokenIn.toHex()
  let poolTokenId = poolId.concat('-').concat(address.toString())
  let poolToken = PoolToken.load(poolTokenId)
  let tokenAmountIn = tokenToDecimal(event.params.tokenAmountIn.toBigDecimal(), poolToken.decimals)
  let newAmount = poolToken.balance.plus(tokenAmountIn)
  poolToken.balance = newAmount
  poolToken.save()

  updatePoolLiquidity(poolId)

  let tx = event.transaction.hash.toHexString().concat('-').concat(event.logIndex.toString())
  let transaction = Transaction.load(tx)
  if (transaction == null) {
    transaction = new Transaction(tx)
  }
  transaction.event = 'join'
  transaction.poolAddress = event.address.toHex()
  transaction.userAddress = event.transaction.from.toHex()
  transaction.gasUsed = event.transaction.gasUsed.toBigDecimal()
  transaction.gasPrice = event.transaction.gasPrice.toBigDecimal()
  transaction.tx = event.transaction.hash
  transaction.timestamp = event.block.timestamp.toI32()
  transaction.block = event.block.number.toI32()
  transaction.save()
}

export function handleExitPool(event: LOG_EXIT): void {
  let poolId = event.address.toHex()
  let pool = Pool.load(poolId)
  pool.exitsCount += BigInt.fromI32(1)
  pool.save()

  let address = event.params.tokenOut.toHex()
  let poolTokenId = poolId.concat('-').concat(address.toString())
  let poolToken = PoolToken.load(poolTokenId)
  let tokenAmountOut = tokenToDecimal(event.params.tokenAmountOut.toBigDecimal(), poolToken.decimals)
  let newAmount = poolToken.balance.minus(tokenAmountOut)
  poolToken.balance = newAmount
  poolToken.save()

  updatePoolLiquidity(poolId)

  let tx = event.transaction.hash.toHexString().concat('-').concat(event.logIndex.toString())
  let transaction = Transaction.load(tx)
  if (transaction == null) {
    transaction = new Transaction(tx)
  }
  transaction.event = 'exit'
  transaction.poolAddress = event.address.toHex()
  transaction.userAddress = event.transaction.from.toHex()
  transaction.gasUsed = event.transaction.gasUsed.toBigDecimal()
  transaction.gasPrice = event.transaction.gasPrice.toBigDecimal()
  transaction.tx = event.transaction.hash
  transaction.timestamp = event.block.timestamp.toI32()
  transaction.block = event.block.number.toI32()
  transaction.save()
}

/************************************
 ************** SWAPS ***************
 ************************************/

export function handleSwap(event: LOG_SWAP): void {
  let poolId = event.address.toHex()

  let tokenIn = event.params.tokenIn.toHex()
  let poolTokenInId = poolId.concat('-').concat(tokenIn.toString())
  let poolTokenIn = PoolToken.load(poolTokenInId)
  let tokenAmountIn = tokenToDecimal(event.params.tokenAmountIn.toBigDecimal(), poolTokenIn.decimals)
  let newAmountIn = poolTokenIn.balance.plus(tokenAmountIn)
  poolTokenIn.balance = newAmountIn
  poolTokenIn.save()

  let tokenOut = event.params.tokenOut.toHex()
  let poolTokenOutId = poolId.concat('-').concat(tokenOut.toString())
  let poolTokenOut = PoolToken.load(poolTokenOutId)
  let tokenAmountOut = tokenToDecimal(event.params.tokenAmountOut.toBigDecimal(), poolTokenOut.decimals)
  let newAmountOut = poolTokenOut.balance.minus(tokenAmountOut)
  poolTokenOut.balance = newAmountOut
  poolTokenOut.save()

  updatePoolLiquidity(poolId)

  let swapId = event.transaction.hash.toHexString().concat('-').concat(event.logIndex.toString())
  let swap = Swap.load(swapId)
  if (swap == null) {
    swap = new Swap(swapId)
  }

  let pool = Pool.load(poolId)
  let tokenPrice = TokenPrice.load(tokenIn)
  let totalSwapVolume = pool.totalSwapVolume
  if (tokenPrice !== null) {
    totalSwapVolume = totalSwapVolume.plus(tokenPrice.price.times(tokenAmountIn))
    pool.totalSwapVolume = totalSwapVolume
  }
  pool.swapsCount += BigInt.fromI32(1)
  pool.save()

  swap.caller = event.params.caller
  swap.tokenIn = event.params.tokenIn
  swap.tokenInSym = poolTokenIn.symbol
  swap.tokenOut = event.params.tokenOut
  swap.tokenOutSym = poolTokenOut.symbol;
  swap.tokenAmountIn = tokenAmountIn
  swap.tokenAmountOut = tokenAmountOut
  swap.poolAddress = event.address.toHex()
  swap.poolTotalSwapVolume = totalSwapVolume
  swap.timestamp = event.block.timestamp.toI32()
  swap.save()

  let tx = event.transaction.hash.toHexString().concat('-').concat(event.logIndex.toString())
  let transaction = Transaction.load(tx)
  if (transaction == null) {
    transaction = new Transaction(tx)
  }
  transaction.event = 'swap'
  transaction.poolAddress = event.address.toHex()
  transaction.userAddress = event.transaction.from.toHex()
  transaction.gasUsed = event.transaction.gasUsed.toBigDecimal()
  transaction.gasPrice = event.transaction.gasPrice.toBigDecimal()
  transaction.tx = event.transaction.hash
  transaction.timestamp = event.block.timestamp.toI32()
  transaction.block = event.block.number.toI32()
  transaction.save()
}


/************************************
 *********** POOL SHARES ************
 ************************************/

 export function handleTransfer(event: Transfer): void {

   let poolId = event.address.toHex()

   const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'

   let isMint = event.params.src.toHex() == ZERO_ADDRESS
   let isBurn = event.params.dst.toHex() == ZERO_ADDRESS

   let poolShareFromId = poolId.concat('-').concat(event.params.src.toHex())
   let poolShareFrom = PoolShare.load(poolShareFromId)

   let poolShareToId = poolId.concat('-').concat(event.params.dst.toHex())
   let poolShareTo = PoolShare.load(poolShareToId)

   let pool = Pool.load(poolId)

   if (isMint) {
     if (poolShareTo == null) {
       createPoolShareEntity(poolShareToId, poolId, event.params.dst.toHex())
       poolShareTo = PoolShare.load(poolShareToId)
     }
     poolShareTo.balance += tokenToDecimal(event.params.amt.toBigDecimal(), 18)
     poolShareTo.save()
     pool.totalShares += tokenToDecimal(event.params.amt.toBigDecimal(), 18)
   } else if (isBurn) {
     if (poolShareFrom == null) {
       createPoolShareEntity(poolShareFromId, poolId, event.params.src.toHex())
       poolShareFrom = PoolShare.load(poolShareFromId)
     }
     poolShareFrom.balance -= tokenToDecimal(event.params.amt.toBigDecimal(), 18)
     poolShareFrom.save()
     pool.totalShares -= tokenToDecimal(event.params.amt.toBigDecimal(), 18)
   } else {
     if (poolShareTo == null) {
       createPoolShareEntity(poolShareToId, poolId, event.params.dst.toHex())
       poolShareTo = PoolShare.load(poolShareToId)
     }
     poolShareTo.balance += tokenToDecimal(event.params.amt.toBigDecimal(), 18)
     poolShareTo.save()

     if (poolShareFrom == null) {
       createPoolShareEntity(poolShareFromId, poolId, event.params.src.toHex())
       poolShareFrom = PoolShare.load(poolShareFromId)
     }
     poolShareFrom.balance -= tokenToDecimal(event.params.amt.toBigDecimal(), 18)
     poolShareFrom.save()
   }

   pool.save()
 }
