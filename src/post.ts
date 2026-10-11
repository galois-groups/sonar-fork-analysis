import { cleanUpCheckout } from './checkout.js'
import { reportInterrupted } from './status.js'

/* v8 ignore next 5 */
try {
  await reportInterrupted()
} finally {
  cleanUpCheckout()
}
