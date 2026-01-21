// MongoDB Replica Set initialization script
// This script is executed automatically when the container starts
// to configure a single-node replica set (required for transactions)

rs.initiate({
  _id: "rs0",
  members: [
    {
      _id: 0,
      host: "localhost:27017"
    }
  ]
});

console.log("Replica set 'rs0' initialized successfully");
