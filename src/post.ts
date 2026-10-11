import { cleanUpCheckout } from './checkout.js'
import { reportInterrupted } from './status.js'

// The clean-up first: the report waits on the network, and a forced cancel would skip what follows.
/* v8 ignore next 2 */
cleanUpCheckout()
await reportInterrupted()
