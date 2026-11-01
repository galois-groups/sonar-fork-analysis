CREATE TABLE report (
    year integer,
    month integer,
    day integer,
    region text,
    product text,
    total numeric,
    PRIMARY KEY (year, month, day, region, product)
);
