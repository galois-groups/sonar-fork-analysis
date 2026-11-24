from fixture.calc import add, scale


def test_add():
    assert add(2, 3) == 5


def test_scale():
    assert scale([1, 2], 3) == [3, 6]
