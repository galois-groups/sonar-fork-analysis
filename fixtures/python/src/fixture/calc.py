def add(a, b):
    return a + b


def scale(values, factor):
    return [value * factor for value in values]


# Deliberate issue for Sonar to find, in code no test covers.
def double(n):
    tripled = n * 3
    return n * 2
