const fs = require('fs-extra');
const path = require('path');
const pathExists = require('path-exists');
const templateBuilderUtils = require('@icedesign/template-builder/utils/');
const template = require('../../template');
const log = require('../../logger');
const settings = require('../settings');
const logger = require('../../logger');
const nodeScaffoldInfo = require('../../config/nodeScaffold');
const { getClientPath } = require('../../paths');

module.exports = (_options, afterCreateRequest) => {
  const {
    scaffold,
    layoutConfig,
    isCustomScaffold,
    targetPath, // 项目路径
    projectName,
    nodeFramework
  } = _options;
  const isAlibaba = settings.get('isAlibaba');

  let fn;
  let createClient;
  let needCreateDefflow;
  if (isCustomScaffold) {
    needCreateDefflow = isAlibaba;
    layoutConfig.directory = targetPath;
    layoutConfig.name = projectName;
    fn = templateBuilderUtils.generateTemplate(layoutConfig);
  } else {
    const scaffoldDevDeps = (scaffold && scaffold.devDependencies) || {};
    needCreateDefflow = nodeFramework ? false : (isAlibaba && scaffoldDevDeps['ice-scripts']);
    if (nodeFramework) {
      // @TODO afterCreateRequest
      // 解压node模板的promise
      fn = template.createProject(
        getOptions(_options, nodeFramework, true),
        afterCreateRequest
      );
      // node模板中解压前端模板的promise
      createClient = template.createProject(
        getOptions(_options, nodeFramework),
        afterCreateRequest
      );
    } else {
      fn = template.createProject(getOptions(_options), afterCreateRequest);
    }
  }

  return fn
    .then(() => {
      if(nodeFramework) { // 如果是 node 模板，此处解压前端模板到已有的项目中
        return new Promise((resolve) => {
          createClient.then(() => {resolve()});
        });
      }
    })
    .then(() => {
      generateAbcJsonFile(needCreateDefflow, targetPath, projectName);
    })
    .then(() => {
      updateScaffoldConfig(isCustomScaffold, layoutConfig);
    })
    .then(() => {
      if (nodeFramework) {
        processNodeProject(targetPath, nodeFramework);
      }
    })
    .then(() => {
      log.report('app', {
        action: isCustomScaffold
          ? 'custom-generator-project'
          : ( nodeFramework ? nodeFramework : 'generator-project' ),
        scaffold: scaffold.name || 'custom-react-template',
        group: isAlibaba ? 'alibaba' : 'outer',
      });
      return Promise.resolve();
    });
};

/**
 * 
 * @param {*} _options 
 * @param {*} nodeFramework // 模板类型：koa2, midway
 * @param {*} isNode // 标识是node模板本身，还是node模板中需要解压的前端模板，true表示是node模板本身。
 */
function getOptions(_options, nodeFramework = '', isNode = false) {
  const isNodeFramework = nodeFramework && isNode; // node模板本身
  const isTemplateInNode = nodeFramework && !isNode; // node模板中的前端模板

  const destDir = isTemplateInNode
    ? getClientPath(_options.targetPath, nodeFramework)
    : _options.targetPath;
  const scaffold = isNodeFramework
    ? nodeScaffoldInfo[nodeFramework].tarball
    : _options.scaffold;
  const progressFunc = isNodeFramework
    ? _options.progressFunc.server
    : _options.progressFunc.client;
  return {
    destDir,
    scaffold,
    progressFunc,
    projectName: _options.projectName,
    commonBlock: true,
    interpreter: ({ type, message }, next) => {
      log.info('generate project', type, message);
      switch (type) {
        case 'FILE_CREATED':
          next(true);
          break;
        default:
          next(true);
      }
    },
  };
}

/**
 * 内网环境，生成 abc.json 文件，用于云构建
 * @param {Boolean} needCreateDefflow
 * @param {String}  destDir
 * @param {String}  projectName
 */
function generateAbcJsonFile(needCreateDefflow, destDir, projectName) {
  if (needCreateDefflow) {
    logger.debug('内网用户，创建 abc.json');
    const abcJson = path.join(destDir, 'abc.json');
    return new Promise((resolve) => {
      const abcContext = {
        name: projectName,
        type: 'iceworks',
        builder: '@ali/builder-iceworks',
      };

      if (pathExists.sync(abcJson)) {
        resolve();
      } else {
        fs.writeFile(abcJson, JSON.stringify(abcContext, null, 2), () => {
          resolve();
        });
      }
    });
  } else {
    return Promise.resolve();
  }
}

/**
 * 更新模板配置
 * @param {Boolean} isCustomScaffold
 * @param {Object}  layoutConfig
 */
function updateScaffoldConfig(isCustomScaffold, layoutConfig) {
  if (isCustomScaffold) {
    const currentPath = layoutConfig.directory;
    return new Promise((resolve, reject) => {
      const pkgJSONPath = path.join(currentPath, 'package.json');
      let pkgJSON;
      if ('themeConfig' in layoutConfig) {
        try {
          pkgJSON = fs.readFileSync(pkgJSONPath);
          pkgJSON = JSON.parse(pkgJSON.toString());
          pkgJSON.themeConfig = layoutConfig.themeConfig;
          const data = JSON.stringify(pkgJSON, null, 2) + '\n';
          fs.writeFile(pkgJSONPath, data, 'utf-8', (err) => {
            if (err) {
              reject(err);
            } else {
              resolve(currentPath);
            }
          });
        } catch (err) {
          reject(err);
        }
      } else {
        resolve(currentPath);
      }
    });
  } else {
    return Promise.resolve();
  }
}

/**
 * 处理Node模板和前端模板的文件
 * @param {String} targetPath
 */
function processNodeProject(destDir, nodeFramework) {
  //将node模板中_打头的文件改为.
  const serverDir = path.join(destDir, 'server');
  fs.readdir(serverDir, 'utf8', (err, files) => {
    const nameReg = /^_/;
    files.forEach((currentValue) => {
      if (nameReg.test(currentValue)) {
        const refactorName = currentValue.replace(nameReg, '.');
        fs.renameSync(
          path.join(destDir, currentValue),
          path.join(destDir, refactorName)
        );
      }
    });
  });
  // 合并client下_package.json 和 模板自带package.json的scripts和依赖。
  compoundPkg(destDir, nodeFramework);
}

/**
 * 合并_package.json的依赖和scripts到前端模板的package.json中
 * @param {String} targetPath
 */
function compoundPkg(destDir, nodeFramework) {
  const { pendingFields } = nodeScaffoldInfo[nodeFramework];
  const clientPath = getClientPath(destDir, nodeFramework);
  const _package = fs.readJsonSync(path.join(clientPath, '_package.json'));
  const clientPackage = fs.readJsonSync(path.join(clientPath, 'package.json'));
  const versionReg = /^[\^>>(?==)<<(?==)~]?([0-9]+(?=\.)[0-9]+)/;

  // 注入node模板类型
  clientPackage.templateType = nodeFramework;

  pendingFields.pkgAttrs.forEach((attrName) => {
    if (attrName === 'scripts') { // 直接覆盖
      Object
        .keys(_package[attrName])
        .forEach((currentValue) => {
          clientPackage[attrName][currentValue] = _package[attrName][currentValue];
        });
    } else {
      Object
      .keys(_package[attrName])
      .forEach((currentValue) => {
        if(clientPackage[attrName].hasOwnProperty(currentValue)){
          const _packageVersion = versionReg.exec(_package[attrName][currentValue]);
          const clientVersion = versionReg.exec(clientPackage[attrName][currentValue]);
          if (
            _packageVersion
            && clientVersion
            && parseFloat(clientVersion[1]) < parseFloat(_packageVersion[1])
          ) {
            clientPackage[attrName][currentValue] = _package[attrName][currentValue];
          }
        } else {
          clientPackage[attrName][currentValue] = _package[attrName][currentValue];
        }
      });
    }
    
  });
  fs.writeJsonSync(path.join(clientPath, 'package.json'), clientPackage);
  fs.removeSync(path.join(clientPath, '_package.json'));
}

/**
 * 移动src和public内的文件到外部
 * @param {String} targetPath
 */
// function extractClientFiles(clientPath, pendingFields) {
//   pendingFields.extractDirs.forEach((currentValue) => {
//     fs
//       .readdirSync(
//         path.join(clientPath, currentValue)
//       )
//       .forEach((fileName) => {
//         const originPath = path.join(clientPath, currentValue, fileName);
//         const targetPath = path.join(clientPath, fileName);
//         if (fs.existsSync(targetPath)) {
//           recursionMerge(originPath, targetPath);
//         } else {
//           fs.renameSync(originPath, targetPath);
//         }
//       })
//   })
// }

/**
 * 递归合并同名文件夹
 * @param {String} originPath
 * @param {String} targetPath
 */
// function recursionMerge(originPath, targetPath) {
//   try {
//     let targetFolder = fs.readdirSync(targetPath);
//     let originFolder = fs.readdirSync(originPath);
//     originFolder.forEach((originFile) => {
//       targetFolder.forEach((targetFile) => {
//         if (originFile === targetFile) {
//           recursionMerge(
//             path.join(originPath, originFile),
//             path.join(targetPath, targetFile)
//           );
//           originFolder.splice(
//             originFolder.indexOf(originFile),
//             1
//           );
//         }
//       });
//     });
//     originFolder.forEach((originFile) => {
//       fs.renameSync(
//         path.join(originPath, originFile),
//         path.join(targetPath, originFile)
//       );
//     });
//   } catch (e) {
//     // do nothing
//   }
// }



/**
 * 合并package.json的依赖
 * @param {String} targetPath
 */
// function compoundPkg(destDir, nodeFramework) {
//   const { pendingFields } = nodeScaffoldInfo[nodeFramework];
//   const clientPath = getClientPath(destDir, nodeFramework);
//   // const serverPackage = fs.readJsonSync(path.join(destDir, 'package.json'));
//   const _package = fs.readJsonSync(path.join(clientPath, '_package.json'));
//   const clientPackage = fs.readJsonSync(path.join(clientPath, 'package.json'));
//   const versionReg = /^[\^>>(?==)<<(?==)~]?([0-9]+(?=\.)[0-9]+)/;
//   if (clientPackage.hasOwnProperty('themeConfig')) {
//     serverPackage.themeConfig = clientPackage.themeConfig;
//   }
//   if (clientPackage.hasOwnProperty('keywords')) {
//     serverPackage.keywords = clientPackage.keywords;
//   }
//   // 注入node模板类型
//   serverPackage.templateType = nodeFramework;
//   pendingFields.pkgAttrs.forEach((attrName) => {
//     Object
//       .keys(clientPackage[attrName])
//       .forEach((currentValue) => {
//         if(serverPackage[attrName].hasOwnProperty(currentValue)){
//           const serverVersion = versionReg.exec(serverPackage[attrName][currentValue]);
//           const clientVersion = versionReg.exec(clientPackage[attrName][currentValue]);
//           if (
//             serverVersion
//             && clientVersion
//             && parseFloat(serverVersion[1]) < parseFloat(clientVersion[1])
//           ) {
//             serverPackage[attrName][currentValue] = clientPackage[attrName][currentValue];
//           }
//         } else {
//           serverPackage[attrName][currentValue] = clientPackage[attrName][currentValue];
//         }
//       });
//   });
//   fs.writeJsonSync(path.join(destDir, 'package.json'), serverPackage);
// }
