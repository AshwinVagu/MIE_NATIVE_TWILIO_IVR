require('dotenv').config();
const express = require('express');
const app = express();
const ivrRoutes = require('./routes/ivr');

app.use(express.urlencoded({ extended: true }));
app.use(express.json());

app.use('/', ivrRoutes);

//  For this project to work with the local LLM/MIE_LLM_function_calling example maybe change the port
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`IVR server running on port ${PORT}`);
});
