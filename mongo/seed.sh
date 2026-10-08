#!/bin/sh
# Runs only on first start of an empty data volume.
mongorestore --username "$MONGO_INITDB_ROOT_USERNAME" --password "$MONGO_INITDB_ROOT_PASSWORD" \
  --authenticationDatabase admin --archive=/seed/seed.archive --drop
