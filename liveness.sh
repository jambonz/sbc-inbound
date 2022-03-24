#!/bin/sh

TCP_SERVER_PORT="${DRACHTIO_PORT:-4000}"
nc -v -z localhost $TCP_SERVER_PORT

# if last command exited with non zero
if [ $? != 0 ]
then
    exit 1
fi

HTTP_SERVER_PORT="${HTTP_PORT:-3000}"
printf 'GET /system-health HTTP/1.1\r\nHost: localhost\r\n\r\n' | nc -v -z localhost 3000

if [ $? != 0 ]
then
    exit 1
fi

exit 0