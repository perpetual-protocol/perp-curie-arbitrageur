// eslint-disable-next-line @typescript-eslint/no-var-requires,no-undef
const slsw = require("serverless-webpack");

// eslint-disable-next-line no-undef
module.exports = {
  entry: slsw.lib.entries,
  target: "node",
  // Generate sourcemaps for proper error messages
  devtool: 'source-map',
  mode: slsw.lib.webpack.isLocal ? "development" : "production",
  optimization: {
    minimize: false // So it won't rename the class name and break dynamo-easy's model
  },

  // Exclude 'aws-sdk' and all its submodules because it does not work in webpack (some relative paths break after bundling).
  // Since AWS Lambda will provide it in runtime context, we don't need to bundle it in the first place.
  externals: /^(aws-sdk|aws-sdk\/.+)$/i,

  // to address ethers v5 bug: https://github.com/ethers-io/ethers.js/issues/1108#issuecomment-730971836
  resolve: {
    mainFields: ["main"],
  },
};
