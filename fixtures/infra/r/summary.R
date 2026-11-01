# TODO: read the threshold from the configuration.
above <- function(values, threshold) {
  values[values > threshold]
}
