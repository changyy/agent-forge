FROM php:8.3-apache

ENV PHORGE_DIR=/opt/phorge \
    DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y --no-install-recommends \
        git \
        ca-certificates \
        mariadb-client \
        libpng-dev \
        libjpeg-dev \
        libfreetype6-dev \
        libicu-dev \
        libzip-dev \
        libonig-dev \
        libcurl4-openssl-dev \
        libssl-dev \
        python3 \
        procps \
    && rm -rf /var/lib/apt/lists/*

RUN docker-php-ext-configure gd --with-freetype --with-jpeg \
    && docker-php-ext-install -j"$(nproc)" \
        mysqli \
        pdo_mysql \
        gd \
        intl \
        zip \
        bcmath \
        mbstring \
        pcntl \
        opcache

RUN pecl install apcu \
    && docker-php-ext-enable apcu

RUN a2enmod rewrite headers

RUN mkdir -p "${PHORGE_DIR}" \
    && git clone --depth=1 https://we.phorge.it/source/phorge.git "${PHORGE_DIR}/phorge" \
    && git clone --depth=1 https://we.phorge.it/source/arcanist.git "${PHORGE_DIR}/arcanist"

COPY config/php-phorge.ini /usr/local/etc/php/conf.d/zz-phorge.ini
COPY config/apache-phorge.conf /etc/apache2/sites-available/000-default.conf
COPY config/mariadb-client.cnf /etc/mysql/conf.d/disable-ssl.cnf

COPY scripts/entrypoint.sh /usr/local/bin/entrypoint.sh
COPY scripts/init-users.php "${PHORGE_DIR}/phorge/scripts/init-users.php"
RUN chmod +x /usr/local/bin/entrypoint.sh

RUN mkdir -p /var/repo /var/phorge-files /var/run/phorge \
    && chown -R www-data:www-data /var/repo /var/phorge-files /var/run/phorge "${PHORGE_DIR}"

EXPOSE 80

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD ["apache"]
